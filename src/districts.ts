import { InlineKeyboard } from 'ultra-telegram-framework';
import { db } from './db.js';

export interface District { id: number; name: string; }
export interface SubDistrict { id: number; name: string; }

export async function getDistricts(botId: number): Promise<District[]> {
  const { data, error } = await db
    .from('districts')
    .select('id, name')
    .eq('bot_id', botId)
    .order('id');

  if (error) return [];
  return (data as District[]) ?? [];
}

export async function getSubDistricts(districtId: number): Promise<SubDistrict[]> {
  const { data, error } = await db
    .from('sub_districts')
    .select('id, name')
    .eq('district_id', districtId)
    .order('id');

  if (error) return [];
  return (data as SubDistrict[]) ?? [];
}

export function buildListKeyboard(
  items: { id: number; name: string }[],
  prefix: string
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    kb.text(item.name, `${prefix}:${item.id}`).row();
  }
  return kb;
}