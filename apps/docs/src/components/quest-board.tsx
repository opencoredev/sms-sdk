import { useEffect, useId, useState } from "react";
import { getQuestProgress } from "@/lib/quest-progress";
import { FieldGuideIcon } from "./docs-icon";

type QuestStep = {
  id: string;
  label: string;
};

export function QuestBoard({
  id,
  steps,
}: {
  id: string;
  steps: readonly QuestStep[];
}) {
  const titleId = useId();
  const storageKey = `sdk-field-guide:quest:${id}`;
  const [completed, setCompleted] = useState<boolean[]>(() => steps.map(() => false));

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;

    try {
      const values: unknown = JSON.parse(saved);
      if (Array.isArray(values)) {
        setCompleted(steps.map((_, index) => values[index] === true));
      }
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [steps, storageKey]);

  const progress = getQuestProgress(completed);

  function toggleStep(index: number) {
    const next = completed.map((value, stepIndex) => (stepIndex === index ? !value : value));
    setCompleted(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  }

  return (
    <section aria-labelledby={titleId} className="quest-board not-prose my-8">
      <div className="quest-board__header">
        <span className="quest-board__icon" aria-hidden="true">
          <FieldGuideIcon name="champion" />
        </span>
        <div>
          <p className="quest-board__eyebrow">Quest progress</p>
          <h2 id={titleId}>Complete this path</h2>
        </div>
        <span className="quest-board__xp">{progress.xp} XP</span>
      </div>
      <div
        aria-label="Quest progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percent}
        className="quest-board__meter"
        role="progressbar"
      >
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="quest-board__steps">
        {steps.map((step, index) => {
          const isComplete = completed[index] ?? false;
          return (
            <button
              aria-pressed={isComplete}
              className="quest-board__step"
              key={step.id}
              onClick={() => toggleStep(index)}
              type="button"
            >
              <FieldGuideIcon name={isComplete ? "checkCircle" : "circle"} />
              <span>{step.label}</span>
              <span className="quest-board__reward">+25 XP</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
