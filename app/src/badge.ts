// SVG badge generator for MergePay repository bounties
// Renders retro monochrome flat-square badge without external font dependencies.

import { formatUnits } from "viem";

export function renderBadgeSvg(label: string, value: string): string {
  const charWidth = 7.0;
  const pad = 9;
  const labelWidth = Math.round(label.length * charWidth + pad * 2);
  const valueWidth = Math.round(value.length * charWidth + pad * 2);
  const totalWidth = labelWidth + valueWidth;
  const height = 20;

  const escXml = (str: string) =>
    str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] || c);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" role="img" aria-label="${escXml(label)}: ${escXml(value)}">
  <title>${escXml(label)}: ${escXml(value)}</title>
  <rect width="${totalWidth}" height="${height}" fill="#000"/>
  <rect x="0" y="0" width="${labelWidth}" height="${height}" fill="#111"/>
  <rect x="${labelWidth}" y="0" width="${valueWidth}" height="${height}" fill="#fff"/>
  <rect x="0.5" y="0.5" width="${totalWidth - 1}" height="${height - 1}" fill="none" stroke="#000" stroke-width="1"/>
  <g fill="#fff" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="11" font-weight="700">
    <text x="${(labelWidth / 2).toFixed(1)}" y="14">${escXml(label)}</text>
  </g>
  <g fill="#000" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="11" font-weight="600">
    <text x="${(labelWidth + valueWidth / 2).toFixed(1)}" y="14">${escXml(value)}</text>
  </g>
</svg>`;
}

export function formatBadgeValue(totalWei: bigint, count: number): string {
  if (count === 0 || totalWei === 0n) {
    return "no open bounties";
  }
  const formatted = formatUnits(totalWei, 18);
  const num = Number(formatted);
  const displayAmt = num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const bountyWord = count === 1 ? "bounty" : "bounties";
  return `${displayAmt} USDC open · ${count} ${bountyWord}`;
}
