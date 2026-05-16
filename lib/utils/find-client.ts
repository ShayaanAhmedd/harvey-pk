// lib/utils/find-client.ts
// Look up a client record from Supabase by (partial) name.
// Used by the WhatsApp send-to-client route to resolve a name → phone number.

import { createClient } from "@/lib/supabase/server";

export interface ClientRecord {
  id:    string;
  name:  string;
  phone: string;
}

/**
 * Find the first client whose name contains the given string (case-insensitive).
 * Returns null if no match is found.
 */
export async function findClientByName(name: string): Promise<ClientRecord | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("clients")
    .select("id, name, phone")
    .ilike("name", `%${name.trim()}%`)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as ClientRecord;
}
