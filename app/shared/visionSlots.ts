import type { PublicSettings, PublicVisionSettings, VisionSettings, VisionSlot, WorkspaceMode } from './protocol';

export const VISION_SLOTS: readonly VisionSlot[] = ['vision', 'vision-2', 'vision-3', 'vision-4'];

export function visionSlotIndex(slot: VisionSlot): number {
  return VISION_SLOTS.indexOf(slot);
}

export function configuredVisionSlots<T extends VisionSettings>(vision: T & { additional?: T[] }) {
  return VISION_SLOTS.map((id, index) => ({
    id,
    config: (index === 0 ? vision : vision.additional?.[index - 1] ?? {}) as T,
  }));
}

export function enabledVisionSlots(vision: PublicSettings['vision'], workspace: WorkspaceMode = 'written') {
  return configuredVisionSlots<PublicVisionSettings>(vision).filter(({ config, id }) =>
    (workspace === 'interview' ? config.interviewEnabled ?? id === 'vision' : config.enabled ?? id === 'vision') &&
    config.baseUrl?.trim() && config.model?.trim() && config.apiKeySet,
  );
}
