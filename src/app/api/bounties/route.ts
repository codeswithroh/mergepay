import { NextResponse } from 'next/server';
import { getOpenBountyCountAndTotal } from '@/lib/contracts';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repositoryId = searchParams.get('repositoryId');

  if (!repositoryId) {
    return NextResponse.json({ error: 'repositoryId is required' }, { status: 400 });
  }

  const { totalUSDC, count } = await getOpenBountyCountAndTotal(Number(repositoryId));

  return NextResponse.json({ totalUSDC, count });
}
