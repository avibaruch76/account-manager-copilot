// research-checks.js
// Source of truth for research check definitions.
// Mandatory checks always run. Optional checks run when their ID is in enabledOptionalIds.
// IDs match BUILTIN_CHECK_DEFAULTS in insight-loop-prototype.html for UI compatibility.
'use strict';

const CHECKS = {
  mandatory: [
    {
      id: 'ggr_trend',
      name: 'GGR 6-Month Trend',
      query: 'Monthly GGR in EUR, active players, and GGR per player — is it growing, flat, or declining? Include month-over-month percentage changes.'
    },
    {
      id: 'concentration',
      name: 'Game Concentration Risk',
      query: 'Top 15 games by GGR share. Is any single game dominant? What percentage of total GGR do the top 3 games represent? Flag if any game exceeds 40% of total.'
    },
    {
      id: 'hidden_gems',
      name: 'Hidden Gem Games',
      query: 'Games with above-average GGR/player but below-average player count — high-value content that is underexposed. Which deserve more promotion?'
    },
    {
      id: 'benchmark_gap',
      name: 'Global Benchmark Gap',
      query: 'Compare this operator\'s top games against the global top 10 games by GGR. Which globally popular games are missing or underperforming? Quantify the gap.'
    },
    {
      id: 'new_launches',
      name: 'New Game Launches (90 Days)',
      query: 'Games launched in the last 90 days — GGR, player adoption, and performance vs global average. Is the operator adopting new content?'
    },
    {
      id: 'open_scan',
      name: 'Open Opportunity Scan',
      query: 'Any anomalies, patterns, or opportunities not covered by the above: unusual GGR/player ratios, sudden drops, or disproportionate concentration.'
    }
  ],
  optional: [
    {
      id: 'retention',
      name: 'Player Retention Analysis',
      query: 'Monthly active players and month-over-month retention rate for the last 6 months. Any concerning decline trends?'
    },
    {
      id: 'vip_behavior',
      name: 'VIP Player Behavior',
      query: 'Top players by GGR, average bet, and total VIP revenue contribution. How concentrated is revenue among high-value players?'
    },
    {
      id: 'market_breakdown',
      name: 'Market / Country Breakdown',
      query: 'GGR by country/market. Which markets are growing? Which are declining? Any untapped geographic opportunities?'
    },
    {
      id: 'device_split',
      name: 'Desktop vs Mobile Split',
      query: 'Mobile vs desktop by GGR and players. Is mobile share growing? How does it compare to the global average?'
    },
    {
      id: 'promo_impact',
      name: 'Promotional Round Impact',
      query: 'Promotional vs real-money round percentage and GGR. Is promo spend efficient? Does GGR growth match player growth?'
    },
    {
      id: 'revenue_leakage',
      name: 'Revenue vs GGR Leakage',
      query: 'Compare GGR to invoiced revenue over 6 months — spot deductions or discrepancies.'
    }
  ]
};

module.exports = CHECKS;
