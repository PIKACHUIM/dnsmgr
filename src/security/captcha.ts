const glyphRows: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

const colors = ['#244f87', '#8b3f4d', '#315f52', '#724b8a'];

export function createCaptchaCode(): string {
  let code = '';
  while (code.length < 4) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const byte of bytes) {
      if (byte < 250) code += String(byte % 10);
      if (code.length === 4) break;
    }
  }
  return code;
}

function coordinate(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '');
}

export function renderCaptchaSvg(code: string): string {
  if (!/^\d{4}$/.test(code)) throw new Error('Invalid CAPTCHA code');
  const noise = crypto.getRandomValues(new Uint8Array(72));
  const glyphPath: string[] = [];
  const width = 3.1;
  const height = 4;
  [...code].forEach((digit, index) => {
    const rows = glyphRows[digit]!;
    const angle = ((noise[index * 3]! % 19) - 9) * Math.PI / 180;
    const scaleX = 0.86 + (noise[index * 3 + 1]! % 20) / 100;
    const scaleY = 0.9 + (noise[index * 3 + 2]! % 18) / 100;
    const originX = 8 + index * 33 + (noise[index + 20]! % 4);
    const originY = 5 + (noise[index + 24]! % 5);
    const centerX = 7.75;
    const centerY = 14;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < rows[row]!.length; column += 1) {
        if (rows[row]![column] !== '1') continue;
        const jitterX = (noise[(index * 11 + row * 5 + column) % 72]! % 5) / 10;
        const jitterY = (noise[(index * 13 + row * 3 + column) % 72]! % 5) / 10;
        const corners = [
          [column * width, row * height],
          [column * width + width - 0.25, row * height],
          [column * width + width - 0.25, row * height + height - 0.25],
          [column * width, row * height + height - 0.25],
        ].map(([x, y]) => {
          const dx = (x! - centerX) * scaleX;
          const dy = (y! - centerY) * scaleY;
          return [
            originX + centerX + dx * cosine - dy * sine + jitterX,
            originY + centerY + dx * sine + dy * cosine + jitterY,
          ];
        });
        glyphPath.push(`M${coordinate(corners[0]![0]!)} ${coordinate(corners[0]![1]!)}${corners.slice(1).map(([x, y]) => `L${coordinate(x!)} ${coordinate(y!)}`).join('')}Z`);
      }
    }
  });

  const noisePath = Array.from({ length: 7 }, (_, index) => {
    const x1 = noise[index * 4]! % 140;
    const y1 = noise[index * 4 + 1]! % 48;
    const x2 = noise[index * 4 + 2]! % 140;
    const y2 = noise[index * 4 + 3]! % 48;
    return `M${x1} ${y1}L${x2} ${y2}`;
  }).join('');
  const fill = colors[noise[40]! % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="48" viewBox="0 0 140 48"><rect width="140" height="48" rx="4" fill="#f1f4f8"/><path d="${glyphPath.join('')}" fill="${fill}"/><path d="${noisePath}" fill="none" stroke="#aebbc9" stroke-width="1.1" stroke-linecap="round"/></svg>`;
}
