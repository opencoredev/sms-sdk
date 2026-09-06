export function getQuestProgress(completed: readonly boolean[]): {
  completedCount: number;
  percent: number;
  xp: number;
} {
  const completedCount = completed.filter(Boolean).length;
  const percent = completed.length === 0 ? 0 : Math.round((completedCount / completed.length) * 100);

  return { completedCount, percent, xp: completedCount * 25 };
}
