import { NextResponse } from 'next/server';
import { cache } from '@/lib/cache';
import { getOpenBountyCountAndTotal } from '@/lib/contracts';

const BADGE_CACHE_TTL = 60; // seconds

function generateBadgeSVG(totalUSDC: number, count: number): string {
  const label = 'MergePay';
  const value = count > 0
    ? `${totalUSDC.toFixed(2)} USDC open · ${count} bounty${count !== 1 ? 'ies' : ''}`
    : 'no open bounties';

  const leftWidth = 67; // width of label section
  const rightWidth = value.length * 7.5 + 20; // width of value section
  const totalWidth = leftWidth + rightWidth;
  const height = 28;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-color="#aaa" stop-opacity=".1"/>
  </linearGradient>
  <defs>
    <clipPath id="a">
      <rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/>
    </clipPath>
  </defs>
  <g clip-path="url(#a)">
    <path fill="#555" d="M0 0h${leftWidth}v${height}H0z"/>
    <path fill="#555" d="M0 0h${leftWidth}v${height}H0z"/>
    <path fill="${count > 0 ? '#007ec6' : '#9f9f9f'}" d="M${leftWidth} 0h${rightWidth}v${height}H${leftWidth}z"/>
    <path fill="url(#b)" d="M0 0h${totalWidth}v${height}H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${leftWidth / 2}" y="20" fill="#000" fill-opacity=".3">${label}</text>
    <text x="${leftWidth / 2}" y="19">${label}</text>
    <text aria-hidden="true" x="${leftWidth + rightWidth / 2}" y="20" fill="#000" fill-opacity=".3">${value}</text>
    <text x="${leftWidth + rightWidth / 2}" y="19">${value}</text>
  </g>
</svg>`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner, repo } = await params;

  const key = `badge:${owner}/${repo}`;
  const result = await cache.get(key, async () => {
    // Resolve repository_id via GitHub API
    const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (!ghResp.ok) {
      return { totalUSDC: 0, count: 0 };
    }
    const ghData = await ghResp.json();
    const repositoryId = ghData.id;

    const { totalUSDC, count } = await getOpenBountyCountAndTotal(repositoryId);
    return { totalUSDC, count };
  }, BADGE_CACHE_TTL);

  const svg = generateBadgeSVG(result.totalUSDC, result.count);

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': `public, max-age=${BADGE_CACHE_TTL}`,
    },
  });
}
