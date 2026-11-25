// The maître mascot (16x16), the same pixels as the identity sheet in docs/mockups/identity.html.
export const MASCOT_SIZE = 16;
export const OUTLINE = '#140b08';

export function drawMascot(R) {
  R(2, 12, 12, 4, '#24242e'); R(6, 12, 4, 3, '#efeadf'); R(5, 12, 2, 2, '#c0262a'); R(9, 12, 2, 2, '#c0262a'); R(7, 12, 2, 1, '#8a1a1a');
  R(7, 11, 2, 1, '#dca97a');
  R(4, 4, 8, 7, '#f6cfa0'); R(11, 5, 1, 5, '#dca97a'); R(5, 10, 6, 1, '#dca97a'); R(3, 7, 1, 2, '#f6cfa0'); R(12, 7, 1, 2, '#dca97a');
  R(4, 2, 8, 2, '#c8c8d0'); R(3, 3, 1, 3, '#c8c8d0'); R(12, 3, 1, 3, '#8a8a94'); R(5, 4, 6, 1, '#c8c8d0'); R(9, 2, 3, 2, '#8a8a94'); R(6, 2, 1, 1, '#ffffff');
  R(5, 6, 2, 1, '#8a8a94'); R(9, 6, 2, 1, '#8a8a94'); R(5, 7, 1, 1, '#140b08'); R(10, 7, 1, 1, '#140b08');
  R(5, 9, 6, 1, '#5a5a64'); R(4, 10, 1, 1, '#5a5a64'); R(11, 10, 1, 1, '#5a5a64');
}

// Rows of colors (null = transparent), with the one-pixel outline around the painted shape.
export function mascotGrid() {
  const n = MASCOT_SIZE;
  const grid = Array.from({ length: n }, () => Array(n).fill(null));
  drawMascot((x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < n && yy < n) grid[yy][xx] = c;
  });
  const painted = (x, y) => x >= 0 && y >= 0 && x < n && y < n && grid[y][x] !== null;
  return grid.map((row, y) => row.map((c, x) =>
    c ?? (painted(x - 1, y) || painted(x + 1, y) || painted(x, y - 1) || painted(x, y + 1) ? OUTLINE : null)));
}
