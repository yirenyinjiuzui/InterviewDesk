import type { PersonalInfo } from './protocol';

export const PERSONAL_INFO_CATEGORIES = {
  education: ['学历', 'Education'],
  responsibilities: ['项目职责', 'Project responsibilities'],
  skills: ['技能程度', 'Skill level'],
  availability: ['实习／到岗安排', 'Availability'],
} as const;

/** Text remains bounded inside the shared material budget, never inferred from JD. */
export function personalInfoContext(info?: PersonalInfo): string {
  const confirmed: string[] = [];
  const pending: string[] = [];
  for (const key of Object.keys(PERSONAL_INFO_CATEGORIES) as (keyof typeof PERSONAL_INFO_CATEGORIES)[]) {
    const entry = info?.[key];
    const label = PERSONAL_INFO_CATEGORIES[key][0];
    if (entry?.confirmed.trim()) confirmed.push(`${label}：${entry.confirmed.trim().slice(0, 200)}`);
    if (entry?.pending.trim()) pending.push(`${label}：${entry.pending.trim().slice(0, 200)}`);
  }
  return [confirmed.length ? `【用户本场已确认】\n${confirmed.join('\n')}` : '',
    pending.length ? `【待确认（不得当作个人事实）】\n${pending.join('\n')}` : ''].filter(Boolean).join('\n');
}
