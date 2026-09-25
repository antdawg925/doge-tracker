/**
 * Browser Supabase client. Only public-safe values here:
 *   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (anon or sb_publishable_… key).
 * Data access is protected by Row Level Security, not by hiding these.
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
