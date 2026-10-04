// Deletes a Gratitude Garden account from the web, for people without the app (Play requires
// this page). It does exactly what the app does in GardenRepository.deleteOwnAccount:
//
//   1. sign in with the account's password, which proves it's theirs;
//   2. delete every stored photo through the Storage API, because Supabase refuses to delete
//      a user who still owns files and SQL can't delete them;
//   3. call delete_current_user, whose cascade removes every row the account owns.
//
// The URL and key are the public ones the app ships with. Everything else is guarded by the
// database: both RPCs act only on the signed-in user (auth.uid()).

(function () {
  "use strict";

  const SUPABASE_URL = "https://wllqgdjkkhztbefdvvsf.supabase.co";
  const SUPABASE_KEY = "sb_publishable_0Z0mdigBo0asGmSO8y-09w_ij8fHlby";
  const PHOTO_BUCKET = "entry-photos";
  // PostgREST's row cap; a full page means there may be more to fetch (MAX_ROWS in the app).
  const MAX_ROWS = 1000;
  // The Storage API takes at most 1000 names per remove.
  const REMOVE_BATCH = 1000;

  const $ = (id) => document.getElementById(id);

  if (!window.supabase) {
    show($("signin-msg"), "This page couldn't load what it needs. Check your connection and reload.");
    $("signin-btn").disabled = true;
    return;
  }

  // Nothing is kept in the browser: no saved session, no refresh in the background.
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  function show(el, text, kind) {
    el.textContent = text;
    if (kind) el.className = "message " + kind;
    el.hidden = false;
  }

  function hide(el) {
    el.hidden = true;
  }

  function signInMessage(error) {
    const code = error && error.code;
    if (code === "invalid_credentials") return "That email and password don't match.";
    if (code === "email_not_confirmed") return "This account's email was never confirmed. Email us below and we'll delete it for you.";
    if (code === "over_request_rate_limit") return "Too many tries. Wait a minute, then try again.";
    if (error && /fetch|network/i.test(error.message || "")) return "We can't reach the garden right now. Check your connection and try again.";
    return "We couldn't sign you in. Please try again.";
  }

  // ── Step 1: sign in ──────────────────────────────────────────────
  $("signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("email").value.trim();
    const password = $("password").value;
    const msg = $("signin-msg");
    hide(msg);
    if (!email || !password) {
      show(msg, "Enter your email and password.");
      return;
    }

    const button = $("signin-btn");
    button.disabled = true;
    button.textContent = "Signing in…";
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = "Continue";
    $("password").value = "";

    if (error || !data.user) {
      show(msg, signInMessage(error));
      return;
    }

    $("who").textContent = data.user.email || "this account";
    $("signin").hidden = true;
    $("confirm").hidden = false;
    $("typed").focus();
  });

  // ── Step 2: confirm and delete ───────────────────────────────────
  $("typed").addEventListener("input", () => {
    $("delete-btn").disabled = $("typed").value.trim().toUpperCase() !== "DELETE";
  });

  $("cancel-btn").addEventListener("click", async () => {
    await client.auth.signOut({ scope: "local" });
    $("typed").value = "";
    $("delete-btn").disabled = true;
    hide($("confirm-msg"));
    $("confirm").hidden = true;
    $("signin").hidden = false;
  });

  $("confirm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if ($("typed").value.trim().toUpperCase() !== "DELETE") return;

    const button = $("delete-btn");
    const cancel = $("cancel-btn");
    const msg = $("confirm-msg");
    button.disabled = true;
    cancel.disabled = true;
    button.textContent = "Deleting…";
    show(msg, "Removing your photos…", "info");

    try {
      await removePhotos();
      show(msg, "Removing your account…", "info");
      const { error } = await client.rpc("delete_current_user");
      if (error) throw error;
    } catch (error) {
      button.textContent = "Delete forever";
      button.disabled = false;
      cancel.disabled = false;
      show(msg, "Something went wrong and your account wasn't fully deleted. Try again, or email us below.", "error");
      return;
    }

    // The user no longer exists, so a server sign-out would only fail.
    await client.auth.signOut({ scope: "local" });
    $("confirm").hidden = true;
    $("done").hidden = false;
  });

  // Delete every photo the account owns, a page of names at a time, until a short page.
  async function removePhotos() {
    for (;;) {
      const { data, error } = await client.rpc("own_photo_objects");
      if (error) throw error;
      // setof text comes back as plain strings or as {own_photo_objects: "name"}.
      const names = (data || [])
        .map((row) => (typeof row === "string" ? row : row && Object.values(row)[0]))
        .filter((name) => typeof name === "string");
      for (let i = 0; i < names.length; i += REMOVE_BATCH) {
        const { error: removeError } = await client.storage
          .from(PHOTO_BUCKET)
          .remove(names.slice(i, i + REMOVE_BATCH));
        if (removeError) throw removeError;
      }
      if (names.length < MAX_ROWS) return;
    }
  }
})();
