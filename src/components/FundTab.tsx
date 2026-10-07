'use client';

import { useState } from 'react';
import { Copy } from 'lucide-react';

export function FundTab() {
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [usdcAmount, setUsdcAmount] = useState('');
  const [funded, setFunded] = useState(false);

  const handleFund = async () => {
    // Fund logic here
    setFunded(true);
  };

  const badgeMarkdown = `![MergePay Bounty](${`https://mergepay.app/badge/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}.svg`})`;

  const copyBadgeMarkdown = () => {
    navigator.clipboard.writeText(badgeMarkdown);
  };

  if (funded) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-green-600 mb-2">✅ Funded Successfully!</h2>
        <p className="text-gray-600 mb-4">Your repository is now ready to accept bounty contributors.</p>
        <div className="bg-gray-100 rounded p-3 flex items-center gap-2">
          <code className="text-sm text-gray-700 flex-1">{badgeMarkdown}</code>
          <button
            onClick={copyBadgeMarkdown}
            className="p-2 hover:bg-gray-200 rounded transition"
            title="Copy badge markdown"
          >
            <Copy className="w-4 h-4 text-gray-600" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4">Fund Bounties</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Repository Owner</label>
          <input
            type="text"
            value={repoOwner}
            onChange={(e) => setRepoOwner(e.target.value)}
            placeholder="e.g. codeswithroh"
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Repository Name</label>
          <input
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="e.g. mergepay"
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">USDC Amount</label>
          <input
            type="number"
            value={usdcAmount}
            onChange={(e) => setUsdcAmount(e.target.value)}
            placeholder="e.g. 1.5"
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
        </div>
        <button
          onClick={handleFund}
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
        >
          Fund Bounties
        </button>
      </div>
    </div>
  );
}
