/*
 * Pure-JS, read-only pre-flight diagnostic for ISO-BMFF video containers
 * (MP4, MOV, M4V, 3GP). No dependencies, no parsing of the media data
 * itself -- it walks only top-level BOX HEADERS (8 or 16 bytes each) to
 * answer the questions a person asking "why won't this video play" needs
 * answered, without ever reading the (often multi-GB) box payloads.
 *
 * Format background:
 *
 *   An ISO-BMFF file is a flat sequence of top-level "boxes" (atoms):
 *
 *     uint32 size;   // total size of this box, including this header
 *     char   type[4];// four-character code, e.g. "ftyp", "moov", "mdat"
 *     ...payload...
 *
 *   size === 1  -> a 64-bit "largesize" follows immediately (8 more bytes),
 *                  and THAT is the real size (used for boxes >4GB).
 *   size === 0  -> this box's payload runs to the end of the file (legal,
 *                  and common for an "mdat" that a crashed recorder never
 *                  finalized -- the recorder writes 0 up front meaning
 *                  "I don't know my final size yet" and is supposed to
 *                  patch it in, or append a trailing "moov", once
 *                  recording finishes normally).
 *
 *   The two boxes this diagnostic cares about:
 *     ftyp -- always first; declares the brand/compatible container flavor.
 *     moov -- the index: track list, sample tables, durations. Without it
 *             most players refuse to open the file at all ("moov atom not
 *             found"), even though every frame is still sitting in...
 *     mdat -- the actual encoded audio/video bytes.
 *
 *   Camera/recorder/OBS-style encoders normally write mdat BEFORE moov
 *   (moov's sample tables aren't known until the last frame is captured),
 *   then append moov once recording stops cleanly. A crash, dead battery,
 *   or full SD card between those two steps produces a file with a
 *   perfectly good mdat and no moov at all -- the classic, repairable
 *   case. "Faststart" files (moov relocated to the front, e.g. by
 *   `-movflags faststart` or web-optimized exports) are the opposite
 *   layout and are usually NOT the files this problem happens to, since
 *   that relocation is itself a proof the file finished writing.
 *
 * This module never reads the whole file: it fetches an 8- or 16-byte
 * header at a computed offset, decides the box's size from that alone,
 * and jumps straight to the next offset -- for a typical file this is a
 * handful of reads totaling well under 1KB, regardless of whether the
 * file is 4MB or 40GB.
 */

'use strict';

const KNOWN_BRANDS = {
  'qt  ': 'QuickTime (.mov)',
  isom: 'ISO Base Media (.mp4)',
  iso2: 'ISO Base Media (.mp4)',
  iso4: 'ISO Base Media (.mp4)',
  iso5: 'ISO Base Media (.mp4)',
  iso6: 'ISO Base Media (.mp4)',
  mp41: 'MPEG-4 (.mp4)',
  mp42: 'MPEG-4 (.mp4)',
  'M4V ': 'iTunes Video (.m4v)',
  'M4A ': 'iTunes Audio (.m4a)',
  'M4P ': 'iTunes Video (.m4p)',
  '3gp4': '3GPP (.3gp)',
  '3gp5': '3GPP (.3gp)',
  '3gp6': '3GPP (.3gp)',
  '3g2a': '3GPP2 (.3g2)',
  avc1: 'AVC baseline (.mp4)',
  mmp4: 'Mobile MP4 (.mp4)',
  heic: 'HEIF image (not a video container this tool handles)',
  mif1: 'HEIF image (not a video container this tool handles)',
  crx: 'Canon Raw (CR3, not a video this tool handles)',
};

// Guardrail against pathological/adversarial box chains; a real top-level
// box list is ftyp + a small handful of others, never dozens.
const MAX_TOP_LEVEL_BOXES = 128;

/**
 * @param {(offset: number, length: number) => Promise<Uint8Array>} readChunk
 *        Must return exactly `length` bytes starting at `offset`, or throw/
 *        reject if that range doesn't exist. Never called with a length
 *        larger than 16 bytes by this module.
 * @param {number} fileSize
 * @returns {Promise<object>} a verdict, see `verdict()` below.
 */
async function diagnose(readChunk, fileSize) {
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    throw new TypeError('fileSize must be a non-negative finite number');
  }
  if (fileSize === 0) {
    return verdict('zero-byte', {
      summary: 'Empty file',
      message: 'This file is 0 bytes. There is nothing here to repair.',
      repairable: false,
    });
  }
  if (fileSize < 8) {
    return verdict('not-iso-bmff', {
      summary: 'Not a video container',
      message: `This file is only ${fileSize} bytes, too small to contain even one valid box header. It is not an MP4/MOV/M4V/3GP file.`,
      repairable: false,
    });
  }

  let boxes;
  try {
    boxes = await walkTopLevelBoxes(readChunk, fileSize);
  } catch (err) {
    return verdict('not-iso-bmff', {
      summary: 'Not a recognizable video container',
      message:
        'This does not look like a standard MP4/MOV/M4V/3GP file: its byte layout does not match the ISO-BMFF box format at all.',
      detail: String((err && err.message) || err),
      repairable: false,
    });
  }

  const ftyp = boxes.find((b) => b.type === 'ftyp');
  if (!ftyp) {
    return verdict('not-iso-bmff', {
      summary: 'No "ftyp" box found',
      message:
        'The file does not start with a valid "ftyp" box. It is either not an ISO-BMFF container, or uses a very old/nonstandard layout this tool does not recognize.',
      repairable: false,
    });
  }

  const brand = await readFtypBrand(readChunk, ftyp, fileSize);
  const moov = boxes.find((b) => b.type === 'moov');
  const mdat = boxes.find((b) => b.type === 'mdat');
  const fragmented = boxes.some((b) => b.type === 'moof');
  const truncatedScan = boxes.truncatedScan === true;

  if (!mdat) {
    return verdict('no-media-data', {
      summary: 'No media data found',
      message:
        'No "mdat" box (the box that holds the actual video/audio bytes) was found anywhere this tool scanned. There are no frames here to recover.',
      brand,
      fragmented,
      repairable: false,
    });
  }

  const mdatEnd = mdat.size === null ? fileSize : mdat.offset + mdat.size;
  const mdatTruncated = mdatEnd > fileSize;
  const faststart = moov ? moov.offset < mdat.offset : null;

  if (!moov) {
    return verdict('missing-index', {
      summary: 'moov atom not found',
      message:
        "This file's media data is present, but its index (the \"moov\" box) is missing. This is the classic \"moov atom not found\" error -- usually caused by a recording that was interrupted before it could finalize (crash, dead battery, full card, app killed mid-write). It is usually repairable with a working reference file from the same device and settings.",
      brand,
      fragmented,
      mdatTruncated,
      faststart,
      repairable: true,
    });
  }

  if (mdatTruncated) {
    return verdict('media-data-truncated', {
      summary: 'Index present, but media data is cut short',
      message:
        'This file has a valid index ("moov"), but the media data ("mdat") is shorter than the index says it should be -- bytes are missing from the end of the file itself, not just the index. This is data loss in the actual video/audio, which an index-rebuilding tool like this one cannot recreate.',
      brand,
      fragmented,
      mdatTruncated,
      faststart,
      repairable: false,
    });
  }

  return verdict('intact', {
    summary: 'This file already looks intact',
    message:
      'Both the index ("moov") and the media data ("mdat") are present, and their sizes are consistent with the file\'s actual length. If it still will not play, the problem is probably something other than a missing index: an unsupported codec, a different kind of corruption inside the frame data, or a player-specific bug.',
    brand,
    fragmented,
    faststart,
    truncatedScan,
    repairable: false,
  });
}

function verdict(kind, fields) {
  return { kind, ...fields };
}

async function walkTopLevelBoxes(readChunk, fileSize) {
  const boxes = [];
  let offset = 0;
  let guard = 0;
  while (offset < fileSize && guard++ < MAX_TOP_LEVEL_BOXES) {
    const header = await readBoxHeader(readChunk, offset, fileSize);
    if (!header) break;
    boxes.push(header);
    if (header.size === null) break; // this box runs to EOF; nothing follows it
    offset = header.offset + header.size;
  }
  if (boxes.length === 0) {
    throw new Error('no valid box header at offset 0');
  }
  if (offset < fileSize && guard >= MAX_TOP_LEVEL_BOXES) {
    boxes.truncatedScan = true;
  }
  return boxes;
}

async function readBoxHeader(readChunk, offset, fileSize) {
  if (offset + 8 > fileSize) return null; // not enough bytes left for even a short header
  const head = await readChunk(offset, 8);
  if (!head || head.length < 8) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let size = dv.getUint32(0, false);
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (!isPlausibleBoxType(type)) {
    throw new Error(`not a plausible box type at offset ${offset}: ${JSON.stringify(type)}`);
  }
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > fileSize) {
      throw new Error(`truncated 64-bit size field for "${type}" at offset ${offset}`);
    }
    const ext = await readChunk(offset, 16);
    const dv2 = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
    const hi = dv2.getUint32(8, false);
    const lo = dv2.getUint32(12, false);
    size = hi * 2 ** 32 + lo;
    headerSize = 16;
  } else if (size === 0) {
    return { type, offset, headerSize, size: null };
  }
  if (size !== null && size < headerSize) {
    throw new Error(`box "${type}" at offset ${offset} declares size ${size}, smaller than its own header`);
  }
  return { type, offset, headerSize, size };
}

function isPlausibleBoxType(type) {
  return /^[\x20-\x7e]{4}$/.test(type);
}

async function readFtypBrand(readChunk, ftyp, fileSize) {
  if (ftyp.offset + 12 > fileSize) return { majorBrand: null, label: 'unknown (ftyp box truncated)' };
  const bytes = await readChunk(ftyp.offset + 8, 4);
  const majorBrand = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return { majorBrand, label: KNOWN_BRANDS[majorBrand] || `unrecognized brand "${majorBrand.trim()}"` };
}

// --- environment-specific readChunk helpers -------------------------------

/** Build a readChunk backed by a browser File/Blob. */
function readChunkForBlob(blob) {
  return async (offset, length) => {
    const slice = blob.slice(offset, offset + length);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  };
}

const api = { diagnose, readChunkForBlob };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.BmffDiagnostic = api;
}
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.BmffDiagnostic = api;
}
