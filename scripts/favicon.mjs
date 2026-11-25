// Writes the mascot as a crisp pixel SVG: one <rect> per horizontal run of one color.
import { mascotGrid } from '../lounge/js/icon.js';

export function gridToSvg(grid) {
  const h = grid.length, w = grid[0].length;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">`;
  grid.forEach((row, y) => {
    for (let x = 0; x < w;) {
      const c = row[x];
      let end = x + 1;
      while (end < w && row[end] === c) end++;
      if (c !== null) out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${c}"/>`;
      x = end;
    }
  });
  return out + '</svg>\n';
}

export const mascotSvg = () => gridToSvg(mascotGrid());
