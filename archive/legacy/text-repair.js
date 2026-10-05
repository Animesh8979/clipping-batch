const CP1252_BYTE_MAP = Object.freeze({
  '€': 0x80,
  '‚': 0x82,
  'ƒ': 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  'ˆ': 0x88,
  '‰': 0x89,
  'Š': 0x8a,
  '‹': 0x8b,
  'Œ': 0x8c,
  'Ž': 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  'š': 0x9a,
  '›': 0x9b,
  'œ': 0x9c,
  'ž': 0x9e,
  'Ÿ': 0x9f,
});

function looksLikeMojibake(text) {
  return /ÃƒÆ’|Ãƒâ€š|ÃƒÂ¢Ã¢â€šÂ¬|Ã Â¤|Ã Â¥|à¤|à¥|Ã¢â‚¬â„¢|Ã¢â‚¬Å“|Ã¢â‚¬\u009d|Ã¢â‚¬\u0098|Ã¢â‚¬\u0099/u.test(String(text || ''));
}

function encodeCp1252LikeBytes(text) {
  const bytes = [];
  for (const char of String(text || '')) {
    const mapped = CP1252_BYTE_MAP[char];
    if (typeof mapped === 'number') {
      bytes.push(mapped);
      continue;
    }

    const codePoint = char.codePointAt(0);
    if (codePoint <= 0xff) {
      bytes.push(codePoint);
      continue;
    }

    return null;
  }
  return Buffer.from(bytes);
}

function repairMojibakeText(text) {
  let value = String(text || '');
  for (let index = 0; index < 4; index += 1) {
    if (!looksLikeMojibake(value)) {
      break;
    }
    const bytes = encodeCp1252LikeBytes(value);
    if (!bytes) {
      break;
    }
    const repaired = bytes.toString('utf8');
    if (!repaired || repaired === value) {
      break;
    }
    value = repaired;
  }
  return value;
}

module.exports = {
  looksLikeMojibake,
  repairMojibakeText,
};
