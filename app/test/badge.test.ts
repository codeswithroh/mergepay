import { formatBadgeValue, renderBadgeSvg } from "../src/badge.ts";

export function runTests() {
  console.log("Running badge unit tests...");
  
  // Test 1: Empty / zero state
  const svg0 = renderBadgeSvg("MergePay", formatBadgeValue(0n, 0));
  if (!svg0.includes("no open bounties") || !svg0.includes("<svg")) {
    throw new Error("Test 1 failed");
  }
  console.log("✓ Test 1 passed (0 bounties -> 'no open bounties')");

  // Test 2: Single bounty
  const svg1 = renderBadgeSvg("MergePay", formatBadgeValue(1000000000000000000n, 1));
  if (!svg1.includes("1 USDC open · 1 bounty")) {
    throw new Error("Test 2 failed");
  }
  console.log("✓ Test 2 passed (1 bounty -> '1 USDC open · 1 bounty')");

  // Test 3: Multiple bounties with decimal
  const svg2 = renderBadgeSvg("MergePay", formatBadgeValue(1250000000000000000n, 2));
  if (!svg2.includes("1.25 USDC open · 2 bounties")) {
    throw new Error("Test 3 failed");
  }
  console.log("✓ Test 3 passed (2 bounties -> '1.25 USDC open · 2 bounties')");

  // Test 4: XML escaping
  const svgEsc = renderBadgeSvg("Merge & Pay <test>", "1 & 2");
  if (!svgEsc.includes("Merge &amp; Pay &lt;test&gt;") || !svgEsc.includes("1 &amp; 2")) {
    throw new Error("Test 4 failed (XML escaping)");
  }
  console.log("✓ Test 4 passed (XML escaping & security)");

  console.log("\nALL BADGE UNIT TESTS PASSED 100%!");
}

runTests();
