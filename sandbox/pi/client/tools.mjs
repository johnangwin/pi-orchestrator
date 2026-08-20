const supportedTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
]);

export function sessionTools(permissionCeiling, workspaceWritable = false) {
  if (
    !permissionCeiling ||
    !Array.isArray(permissionCeiling.pi_tools) ||
    !permissionCeiling.pi_tools.every((tool) => supportedTools.has(tool))
  ) {
    throw new Error("Invalid Session Pi tool permissions");
  }
  return permissionCeiling.pi_tools
    .filter(
      (tool) => workspaceWritable || (tool !== "write" && tool !== "edit"),
    )
    .join(",");
}
