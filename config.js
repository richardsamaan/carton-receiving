// =====================================================================
//  Carton Receiving - settings
//  Paste your Supabase details here (Supabase > Project Settings > API).
//  Leave both empty to run in DEMO MODE (data stays on this one device).
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://noykwvxmlxztlfxhfdbn.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_vn65zwjK4VQDMv6B_v4voQ_iOXnO5Nd",

  APP_NAME: "Carton Receiving",
  // Ignore the SAME barcode read again within this many milliseconds
  // (stops one item being counted twice while the camera is still on it).
  SAME_BARCODE_COOLDOWN_MS: 1500
};
