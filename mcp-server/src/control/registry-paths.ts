export function activeClaimRelativePath(taskId: string): string {
  return `claims/active/${taskId}.yaml`;
}

export function taskRelativePath(taskId: string): string {
  return `tasks/${taskId}.yaml`;
}
