export const architectureDebtAllowances = [
  ...[
    ["src/runtime.ts", 4_800, "MODULE-001 through MODULE-005"]
  ].map(([source, ceiling, tracking]) => ({
    id: `file-lines:${source}`,
    rule: "file-lines",
    source,
    ceiling,
    reason: "Legacy file exceeds the 800-line target; the ceiling prevents further growth while it is split.",
    tracking,
    decision: "docs/architecture/project-structure-plan.md#completion-criteria"
  })),

  ...[
    ["src/runtime.ts", "SunaRuntime", 3_200, "MODULE-001 through MODULE-005"]
  ].map(([source, symbol, ceiling, tracking]) => ({
    id: `class-lines:${source}:${symbol}`,
    rule: "class-lines",
    source,
    symbol,
    ceiling,
    reason: "Legacy class exceeds the 500-line target; the ceiling prevents further growth while responsibilities are extracted.",
    tracking,
    decision: "docs/architecture/project-structure-plan.md#completion-criteria"
  }))
];
