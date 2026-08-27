/**
 * Zero-dependency pure-JS QR Code generator (SVG & Data URI)
 * Implements ISO/IEC 18004 QR Code Model 2 (Byte encoding, Error Correction Level M/L)
 */

// Mode indicators
const MODE_BYTE = 4;

// Error correction levels
const EC_L = 1; // 7% recovery
const EC_M = 0; // 15% recovery
const EC_Q = 3; // 25% recovery
const EC_H = 2; // 30% recovery

// Version table capacities for Byte mode with EC Level M
const CAPACITY_TABLE_M = [
  0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666
];

// Galois Field (GF(256)) math for Reed-Solomon error correction
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d; // generator polynomial x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 255];
  }
})();

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0;
  return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const nextPoly = new Array(poly.length + 1).fill(0);
    const root = EXP_TABLE[i];
    for (let j = 0; j < poly.length; j++) {
      nextPoly[j] ^= gfMul(poly[j], root);
      nextPoly[j + 1] ^= poly[j];
    }
    poly = nextPoly;
  }
  return poly;
}

function rsCalculateRemainder(data, numEcBytes) {
  const genPoly = rsGeneratorPoly(numEcBytes);
  const msg = new Array(data.length + numEcBytes).fill(0);
  for (let i = 0; i < data.length; i++) msg[i] = data[i];

  for (let i = 0; i < data.length; i++) {
    const factor = msg[i];
    if (factor !== 0) {
      for (let j = 0; j < genPoly.length; j++) {
        msg[i + j] ^= gfMul(genPoly[j], factor);
      }
    }
  }
  return msg.slice(data.length);
}

// Table of QR parameters [totalBytes, ecBytesPerBlock, numBlocksG1, dataBytesG1, numBlocksG2, dataBytesG2] for EC Level M
const QR_SPECS_M = {
  1: { totalCodewords: 26, ecCodewords: 10, blocks: [{ count: 1, dataCodewords: 16 }] },
  2: { totalCodewords: 44, ecCodewords: 16, blocks: [{ count: 1, dataCodewords: 28 }] },
  3: { totalCodewords: 70, ecCodewords: 26, blocks: [{ count: 1, dataCodewords: 44 }] },
  4: { totalCodewords: 100, ecCodewords: 18, blocks: [{ count: 2, dataCodewords: 32 }] },
  5: { totalCodewords: 134, ecCodewords: 24, blocks: [{ count: 2, dataCodewords: 43 }] },
  6: { totalCodewords: 172, ecCodewords: 16, blocks: [{ count: 4, dataCodewords: 27 }] },
  7: { totalCodewords: 196, ecCodewords: 18, blocks: [{ count: 4, dataCodewords: 31 }] },
  8: { totalCodewords: 242, ecCodewords: 22, blocks: [{ count: 2, dataCodewords: 38 }, { count: 2, dataCodewords: 39 }] },
  9: { totalCodewords: 292, ecCodewords: 22, blocks: [{ count: 3, dataCodewords: 36 }, { count: 2, dataCodewords: 37 }] },
  10: { totalCodewords: 346, ecCodewords: 26, blocks: [{ count: 4, dataCodewords: 43 }, { count: 1, dataCodewords: 44 }] },
};

// Alignment pattern positions for versions 1..10
const ALIGNMENT_PATTERN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function selectVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    if (byteLength <= CAPACITY_TABLE_M[v]) return v;
  }
  return 10;
}

class BitBuffer {
  constructor() {
    this.buffer = [];
    this.length = 0;
  }

  put(num, length) {
    for (let i = 0; i < length; i++) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    }
  }

  putBit(bit) {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) {
      this.buffer.push(0);
    }
    if (bit) {
      this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
    }
    this.length++;
  }

  getBytes() {
    return this.buffer;
  }
}

function encodeData(text, version) {
  const utf8Bytes = Buffer.from(text, "utf8");
  const bitBuf = new BitBuffer();

  // Mode: Byte (4 bits)
  bitBuf.put(MODE_BYTE, 4);

  // Character count indicator (8 bits for versions 1-9, 16 bits for 10+)
  const countBits = version < 10 ? 8 : 16;
  bitBuf.put(utf8Bytes.length, countBits);

  // Data bytes
  for (let i = 0; i < utf8Bytes.length; i++) {
    bitBuf.put(utf8Bytes[i], 8);
  }

  const spec = QR_SPECS_M[version];
  let totalDataCodewords = 0;
  for (const block of spec.blocks) {
    totalDataCodewords += block.count * block.dataCodewords;
  }

  // Terminator (up to 4 zeroes)
  const remainingBits = totalDataCodewords * 8 - bitBuf.length;
  const termLen = Math.min(4, Math.max(0, remainingBits));
  bitBuf.put(0, termLen);

  // Pad to byte boundary
  while (bitBuf.length % 8 !== 0) {
    bitBuf.putBit(false);
  }

  // Pad bytes (0xEC, 0x11 alternating)
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bitBuf.length < totalDataCodewords * 8) {
    bitBuf.put(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const dataCodewords = bitBuf.getBytes();

  // Split into blocks and compute Reed-Solomon EC
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (const block of spec.blocks) {
    for (let c = 0; c < block.count; c++) {
      const bData = dataCodewords.slice(offset, offset + block.dataCodewords);
      offset += block.dataCodewords;
      const bEc = rsCalculateRemainder(bData, spec.ecCodewords);
      dataBlocks.push(bData);
      ecBlocks.push(bEc);
    }
  }

  // Interleave data codewords
  const finalSequence = [];
  let maxDataLen = 0;
  for (const b of dataBlocks) maxDataLen = Math.max(maxDataLen, b.length);

  for (let i = 0; i < maxDataLen; i++) {
    for (const b of dataBlocks) {
      if (i < b.length) finalSequence.push(b[i]);
    }
  }

  // Interleave EC codewords
  for (let i = 0; i < spec.ecCodewords; i++) {
    for (const b of ecBlocks) {
      if (i < b.length) finalSequence.push(b[i]);
    }
  }

  return finalSequence;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  function setModule(r, c, val) {
    matrix[r][c] = val ? 1 : 0;
    reserved[r][c] = true;
  }

  // 1. Finder patterns (top-left, top-right, bottom-left)
  function placeFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;

        if (
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        ) {
          setModule(nr, nc, true);
        } else {
          setModule(nr, nc, false);
        }
      }
    }
  }

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // 2. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
    if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
  }

  // 3. Alignment patterns
  const alignPos = ALIGNMENT_PATTERN_POS[version] || [];
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      const r = alignPos[i];
      const c = alignPos[j];
      if (reserved[r][c]) continue; // Skip if overlaps with finders

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          setModule(r + dr, c + dc, isEdge || isCenter);
        }
      }
    }
  }

  // 4. Dark module
  setModule(size - 8, 8, true);

  // 5. Reserve format info space
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }

  return { size, matrix, reserved };
}

// Format info: EC Level M (00) + Mask pattern 0 (000) = 00000 -> 0x5412 (BCH 15,5)
const FORMAT_INFO_M_MASK0 = 0x5412;

function placeFormatInfo(matrix, size) {
  const bits = FORMAT_INFO_M_MASK0;
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >>> i) & 1) === 1;

    // Top-left
    if (i < 6) matrix[8][i] = bit ? 1 : 0;
    else if (i < 8) matrix[8][i + 1] = bit ? 1 : 0;
    else if (i === 8) matrix[7][8] = bit ? 1 : 0;
    else matrix[14 - i][8] = bit ? 1 : 0;

    // Split positions
    if (i < 8) matrix[size - 1 - i][8] = bit ? 1 : 0;
    else matrix[8][size - 15 + i] = bit ? 1 : 0;
  }
}

function placeDataBits(matrix, reserved, size, data) {
  let bitIndex = 0;
  const totalBits = data.length * 8;

  let row = size - 1;
  let col = size - 1;
  let direction = -1; // Moving upwards

  while (col > 0) {
    if (col === 6) col--; // Skip vertical timing line

    for (let i = 0; i < size; i++) {
      const r = row + (direction === -1 ? -i : i);
      for (let c = 0; c < 2; c++) {
        const currentCol = col - c;
        if (!reserved[r][currentCol]) {
          let bit = false;
          if (bitIndex < totalBits) {
            const byteVal = data[Math.floor(bitIndex / 8)];
            bit = ((byteVal >>> (7 - (bitIndex % 8))) & 1) === 1;
            bitIndex++;
          }

          // Apply mask 0: (row + col) % 2 === 0
          if ((r + currentCol) % 2 === 0) {
            bit = !bit;
          }

          matrix[r][currentCol] = bit ? 1 : 0;
        }
      }
    }

    row = direction === -1 ? 0 : size - 1;
    direction = -direction;
    col -= 2;
  }
}

/**
 * Generate QR code matrix and export as SVG or Base64 Data URI
 */
function generateQRCodeMatrix(text) {
  const version = selectVersion(Buffer.byteLength(text, "utf8"));
  const data = encodeData(text, version);
  const { size, matrix, reserved } = createMatrix(version);
  placeDataBits(matrix, reserved, size, data);
  placeFormatInfo(matrix, size);
  return { size, matrix };
}

function generateQRCodeSVG(text, options = {}) {
  const margin = options.margin !== undefined ? options.margin : 2;
  const fgColor = options.fgColor || "#0f172a";
  const bgColor = options.bgColor || "#ffffff";
  const { size, matrix } = generateQRCodeMatrix(text);

  const totalSize = size + margin * 2;
  let svgPaths = "";

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        const x = c + margin;
        const y = r + margin;
        svgPaths += `<rect x="${x}" y="${y}" width="1.02" height="1.02" />`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges">
  <rect width="${totalSize}" height="${totalSize}" fill="${bgColor}"/>
  <g fill="${fgColor}">
    ${svgPaths}
  </g>
</svg>`;
}

function generateQRCodeDataURL(text, options = {}) {
  const svg = generateQRCodeSVG(text, options);
  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}

module.exports = {
  generateQRCodeSVG,
  generateQRCodeDataURL,
};
