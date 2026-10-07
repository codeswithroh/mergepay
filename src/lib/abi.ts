export const MergePayABI = [
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true, "name": "repositoryId", "type": "uint256"},
      {"indexed": false, "name": "amount", "type": "uint256"},
      {"indexed": false, "name": "status", "type": "string"}
    ],
    "name": "BountyCreated",
    "type": "event"
  }
] as const;
