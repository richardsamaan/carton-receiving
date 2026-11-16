// =====================================================================
//  Carton Receiving - settings
//  Paste your Supabase details here (Supabase > Project Settings > API).
//  Leave both empty to run in DEMO MODE (data stays on this one device).
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "",        // e.g. "https://abcdefghijk.supabase.co"
  SUPABASE_ANON_KEY: "",   // the "anon public" key

  APP_NAME: "Carton Receiving",
  // Ignore the SAME barcode read again within this many milliseconds
  // (stops one item being counted twice while the camera is still on it).
  SAME_BARCODE_COOLDOWN_MS: 1500
};
