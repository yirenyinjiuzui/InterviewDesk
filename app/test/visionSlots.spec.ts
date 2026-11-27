import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, plainCipher } from '../electron/settings';
import { SessionStore } from '../electron/sessions';
import { configuredVisionSlots, enabledVisionSlots, VISION_SLOTS } from '../shared/visionSlots';
import { sessionWorkspace } from '../shared/workspaces';
import { answerHistory, stopAnswers, updateAnswers } from '../shared/answerState';
import type { StoredSession } from '../shared/protocol';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'mc-four-vision-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('four independent vision interfaces', () => {
  it('preserves the legacy primary slot and exposes three empty extra slots', () => {
    const path = join(directory, 'settings.json');
    writeFileSync(path, JSON.stringify({ version: 2, vision: { baseUrl: 'https://legacy/v1', model: 'legacy-model', apiKeyEnc: plainCipher.encrypt('legacy-key') } }));
    const store = new SettingsStore(path, plainCipher);
    expect(store.getVisionApiKey()).toBe('legacy-key');
    expect(configuredVisionSlots(store.getPublic().vision)).toHaveLength(4);
    expect(enabledVisionSlots(store.getPublic().vision).map((slot) => slot.id)).toEqual(['vision']);
  });

  it('round-trips four credentials without exposing or mixing them', () => {
    const path = join(directory, 'settings.json');
    const store = new SettingsStore(path, plainCipher);
    const configs = VISION_SLOTS.map((id, index) => ({ enabled: true, model: `model-${index}`, baseUrl: `https://${id}.example/v1`, apiKey: `credential-for-interface-${index}` }));
    store.applyPatch({ vision: { ...configs[0], additional: configs.slice(1) } });
    const reloaded = new SettingsStore(path, plainCipher);
    VISION_SLOTS.forEach((slot, index) => {
      expect(reloaded.getApiKeyForSlot(slot)).toBe(configs[index].apiKey);
      expect(readFileSync(path, 'utf8')).not.toContain(configs[index].apiKey);
      expect(JSON.stringify(reloaded.getPublic())).not.toContain(configs[index].apiKey);
    });
    expect(JSON.stringify(reloaded.getPublic())).not.toContain('apiKeyEnc');
    expect(enabledVisionSlots(reloaded.getPublic().vision)).toHaveLength(4);
    reloaded.applyPatch({ vision: { additional: [{ model: 'updated-model' }, { apiKey: '' }] } });
    expect(reloaded.getVisionApiKey('vision-2')).toBe(configs[1].apiKey);
    expect(reloaded.getVisionApiKey('vision-3')).toBeUndefined();
    expect(reloaded.getVisionApiKey('vision-4')).toBe(configs[3].apiKey);
    expect(reloaded.getVisionApiKey()).toBe(configs[0].apiKey);
    reloaded.recordVerification('vision-4', { lastTestOk: false, lastTestCode: 'PERMISSION_DENIED' });
    const slots = configuredVisionSlots(reloaded.getPublic().vision);
    expect(slots[3].config.verification?.lastTestCode).toBe('PERMISSION_DENIED');
    expect(slots[0].config.verification).toBeUndefined();
  });

  it('skips disabled or incomplete slots without preventing other models from answering', () => {
    const store = new SettingsStore(join(directory, 'settings.json'), plainCipher);
    store.applyPatch({ vision: { enabled: false, baseUrl: 'https://primary/v1', model: 'primary', apiKey: 'primary-key', additional: [
      { enabled: true, baseUrl: 'https://second/v1', model: 'second', apiKey: 'second-key' },
      { enabled: true, baseUrl: 'https://third/v1', model: 'third' },
      { enabled: true, baseUrl: '', model: 'fourth', apiKey: 'fourth-key' },
    ] } });
    expect(enabledVisionSlots(store.getPublic().vision).map((slot) => slot.id)).toEqual(['vision-2']);
    expect(() => store.applyPatch({ vision: { additional: [{}, {}, {}, {}] } })).toThrow(/four/);
  });

  it('migrates interview selection independently of existing written selections', () => {
    const path = join(directory, 'settings.json');
    const store = new SettingsStore(path, plainCipher);
    store.applyPatch({ vision: { enabled: false, baseUrl: 'https://one/v1', model: 'one', apiKey: 'one-key', additional: [
      { enabled: true, baseUrl: 'https://two/v1', model: 'two', apiKey: 'two-key' },
      { enabled: true, baseUrl: 'https://three/v1', model: 'three', apiKey: 'three-key' },
    ] } });
    expect(enabledVisionSlots(store.getPublic().vision, 'written').map((slot) => slot.id)).toEqual(['vision-2', 'vision-3']);
    expect(enabledVisionSlots(store.getPublic().vision, 'interview').map((slot) => slot.id)).toEqual(['vision']);
    store.applyPatch({ vision: { interviewEnabled: false, additional: [{ interviewEnabled: true }, { interviewEnabled: false }] } });
    const restored = new SettingsStore(path, plainCipher);
    expect(enabledVisionSlots(restored.getPublic().vision, 'interview').map((slot) => slot.id)).toEqual(['vision-2']);
    expect(enabledVisionSlots(restored.getPublic().vision, 'written').map((slot) => slot.id)).toEqual(['vision-2', 'vision-3']);
    expect(restored.getVisionApiKey()).toBe('one-key');
    expect(restored.getVisionApiKey('vision-2')).toBe('two-key');
    expect(restored.getVisionApiKey('vision-3')).toBe('three-key');
    restored.applyPatch({ vision: { additional: [{ interviewEnabled: false }] } });
    expect(enabledVisionSlots(restored.getPublic().vision, 'interview')).toEqual([]);
  });
});

describe('workspace and model attribution', () => {
  it('keeps legacy interviews and written sessions separate after restart', () => {
    const store = new SessionStore(join(directory, 'sessions.json'));
    store.save({ currentId: 'written', sessions: [
      { id: 'old', name: 'Interview', createdAt: 1, turns: [], segments: [{ id: 1, text: 'Interview only', startTs: 1, endTs: 2 }] },
      { id: 'written', name: 'Written', workspace: 'written', createdAt: 2, turns: [] },
    ] });
    const restored = store.load();
    expect(restored.sessions.filter((session) => sessionWorkspace(session) === 'interview').map((session) => session.id)).toEqual(['old']);
    expect(restored.sessions.filter((session) => sessionWorkspace(session) === 'written').map((session) => session.id)).toEqual(['written']);
    const settings = new SettingsStore(join(directory, 'settings.json'), plainCipher);
    settings.applyPatch({ ui: { workspace: 'written' } });
    expect(new SettingsStore(join(directory, 'settings.json'), plainCipher).getPublic().ui.workspace).toBe('written');
  });

  it('attributes out-of-order answers and preserves one model failure independently', () => {
    const original: StoredSession[] = [{ id: 'written', name: 'Written', workspace: 'written', createdAt: 1,
      turns: VISION_SLOTS.map((slot) => ({ id: slot, kind: 'vision', label: 'Screenshot', text: '', status: 'streaming', visionSlot: slot, batchId: 'same-image' })) }];
    let result = updateAnswers(original, { requestId: 'vision-3', kind: 'model', modelName: 'actual-third', visionSlot: 'vision-3' });
    result = updateAnswers(result, { requestId: 'vision-3', kind: 'done', text: 'answer-three' });
    result = updateAnswers(result, { requestId: 'vision-2', kind: 'error', message: 'provider failed' });
    expect(result[0].turns[2]).toMatchObject({ text: 'answer-three', modelName: 'actual-third', visionSlot: 'vision-3', status: 'done' });
    expect(result[0].turns[1].status).toBe('error');
    expect(result[0].turns[0].status).toBe('streaming');
    const stopped = stopAnswers(result);
    expect(stopped[0].turns.map((turn) => turn.status)).toEqual(['cancelled', 'error', 'done', 'cancelled']);
    expect(updateAnswers(stopped, { requestId: 'vision', kind: 'model', modelName: 'late' })).toEqual(stopped);
  });

  it('sends each interview model its own completed history and the shared text context', () => {
    const turns: StoredSession['turns'] = [
      { id: 'common', kind: 'free', label: 'Shared question', text: 'Shared answer', status: 'done' },
      { id: 'one', kind: 'free', label: 'Question', text: 'Answer from one', status: 'done', visionSlot: 'vision' },
      { id: 'two', kind: 'free', label: 'Question', text: 'Answer from two', status: 'done', visionSlot: 'vision-2' },
      { id: 'stopped', kind: 'free', label: 'Cancelled', text: 'Incomplete', status: 'cancelled', visionSlot: 'vision-2' },
    ];
    const history = answerHistory(turns, 'vision-2');
    expect(history.map((message) => message.content)).toEqual(['Shared question', 'Shared answer', 'Question', 'Answer from two']);
  });
});
