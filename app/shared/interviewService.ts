import type { PublicSettings } from './protocol';
import { enabledVisionSlots } from './visionSlots';

/** The same auxiliary service is shown before the interview and used by main. */
export function interviewService(settings: PublicSettings) {
  if (!settings.llm.answerWithVision) return { id: 'llm' as const, config: settings.llm };
  return enabledVisionSlots(settings.vision, 'interview')[0];
}
