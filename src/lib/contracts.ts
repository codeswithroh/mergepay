import { createPublicClient, http, WalletClient } from 'viem';
import { base } from 'viem/chains';
import { MergePayABI } from './abi';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || `https://mainnet.base.org`;

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

export async function listBounties(repositoryId: bigint | number) {
  try {
    const events = await publicClient.getContractEvents({
      abi: MergePayABI,
      eventName: 'BountyCreated',
      args: { repositoryId: BigInt(repositoryId) },
      fromBlock: 0n,
      toBlock: 'latest',
    });

    const activeBounties = events
      .filter(e => e.eventName === 'BountyCreated' && (e.returnValues as any)?.status === 'active')
      .map(e => e.returnValues);

    return activeBounties;
  } catch (error) {
    console.error('Error fetching bounties:', error);
    return [];
  }
}

export async function getOpenBountyCountAndTotal(repositoryId: number): Promise<{ totalUSDC: number; count: number }> {
  const bounties = await listBounties(BigInt(repositoryId));

  let totalUSDC = 0;
  bounties.forEach((bounty: any) => {
    const amount = Number((bounty.amount ?? 0n) / 1e6); // USDC has 6 decimals
    totalUSDC += amount;
  });

  return { totalUSDC, count: bounties.length };
}
