import { createClient } from
  "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://ettfsfmlzvgexrkxqvqj.supabase.co";
const SUPABASE_KEY = "sb_publishable_g0DghHvJE29vnkrdCXWlBg_sMd9-y-D";

const $ = id => document.getElementById(id);
const form = $("recipeForm");
const bucketName = "recipe-photos";

let db;
let user = null;
let recipes = [];
let selected = null;
let editing = null;
let currentPhotos = [];
let busy = false;
let generation = 0;
let profiles = [];
let profileOwner = null;
let profileBusy = false;
let sessionVersion = 0;
const avatarCache = new Map();

function status(message) {
  $("status").textContent = message;
}

function check(result) {
  if (result.error) throw result.error;
  return result.data;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function bucket() {
  return db.storage.from(bucketName);
}

async function listPhotos(recipe) {
  const folder = `${recipe.owner_id}/${recipe.id}`;
  const files = check(await bucket().list(folder, {
    limit: 100,
    sortBy: { column: "name", order: "asc" }
  }));

  const photos = [];
  for (const file of files) {
    if (!file.id) continue;
    const path = `${folder}/${file.name}`;
    const signed = check(await bucket().createSignedUrl(path, 3600));
    photos.push({ path, url: signed.signedUrl });
  }
  return photos;
}

function imageFor(photo, alt) {
  const image = node("img");
  image.src = photo.url;
  image.alt = alt;
  image.loading = "lazy";
  return image;
}

function metadata(recipe) {
  return [
    `From ${recipe.author}`,
    recipe.minutes !== null ? `${recipe.minutes} minutes` : "",
    recipe.servings !== null ? `Serves ${recipe.servings}` : ""
  ].filter(Boolean).join(" · ");
}

async function loadRecipes() {
  recipes = check(await db.from("recipes")
    .select("*")
    .order("created_at", { ascending: false }));
  render();
}

function render() {
  renderFamily();
  const version = ++generation;
  const query = $("search").value.toLowerCase().trim();
  const category = $("filter").value;

  const matches = recipes.filter(recipe =>
    (!profileOwner || recipe.owner_id === profileOwner) &&
    (!category || recipe.category === category) &&
    [
      recipe.title, recipe.author, recipe.ingredients,
      recipe.instructions, recipe.notes, profileName(recipe.owner_id)
    ].join(" ").toLowerCase().includes(query)
  );

  $("recipes").replaceChildren();
  $("count").textContent = matches.length
    ? `${matches.length} family recipe${matches.length === 1 ? "" : "s"}`
    : recipes.length
      ? "No recipes match your search."
      : "Your cookbook is ready. Add the first family favorite.";

  for (const recipe of matches) {
    const card = node("article", undefined, "card");
    const cover = node("div", "🍽", "cover placeholder");
    const content = node("div", undefined, "card-body");
    const open = node("button", "View recipe");

    content.append(
      node("span", recipe.category, "tag"),
      node("h3", recipe.title),
      node("p", metadata(recipe), "muted"),
      profileButton(recipe.owner_id),
      open
    );
    card.append(cover, content);
    $("recipes").append(card);

    open.addEventListener("click", () => {
      openRecipe(recipe).catch(error => status(error.message));
    });

    listPhotos(recipe).then(photos => {
      if (version !== generation || !photos.length) return;
      const image = imageFor(photos[0], recipe.title);
      image.className = "cover";
      cover.replaceWith(image);
    }).catch(() => {
      // Keep the placeholder when a photo cannot be loaded.
    });
  }
}

async function openRecipe(recipe) {
  selected = recipe;
  $("recipeTitle").textContent = recipe.title;
  $("recipeMeta").textContent = metadata(recipe);
  $("recipeSubmitter").replaceChildren(profileButton(recipe.owner_id));
  $("recipeIngredients").textContent = recipe.ingredients;
  $("recipeInstructions").textContent = recipe.instructions;
  $("recipeNotes").textContent = recipe.notes;
  $("notesSection").hidden = !recipe.notes;
  $("edit").hidden = recipe.owner_id !== user.id;
  $("delete").hidden = recipe.owner_id !== user.id;
  $("recipePhotos").replaceChildren();
  $("viewer").showModal();

  const photos = await listPhotos(recipe);
  if (selected?.id !== recipe.id || !$("viewer").open) return;
  $("recipePhotos").replaceChildren(
    ...photos.map(photo => imageFor(photo, recipe.title))
  );
}

function splitIngredients(text) {
  return text.split(/\r?\n/).filter(line => line.trim());
}

function joinIngredients(values) {
  return values.map(value => String(value).trim()).filter(Boolean).join("\n");
}

function addIngredientBox(value = "", focus = false) {
  const number = $("ingredientBoxes").children.length + 1;
  const input = node("input");
  input.type = "text";
  input.name = "ingredient";
  input.maxLength = 20000;
  input.placeholder = number === 1 ? "e.g. 2 cups flour" : "Next ingredient";
  input.setAttribute("aria-label", `Ingredient ${number}`);
  input.required = number === 1;
  input.value = value;
  $("ingredientBoxes").append(input);
  if (focus) input.focus();
}

function setIngredientBoxes(text) {
  $("ingredientBoxes").replaceChildren();
  const lines = splitIngredients(text);
  for (const line of lines.length ? lines : [""]) addIngredientBox(line);
}

async function openEditor(recipe = null) {
  editing = recipe;
  form.reset();
  setIngredientBoxes(recipe?.ingredients || "");
  currentPhotos = [];
  $("existingPhotos").replaceChildren();
  $("formMessage").textContent = "";
  $("editorTitle").textContent = recipe ? "Edit recipe" : "Add a recipe";

  if (recipe) {
    for (const key of [
      "title", "author", "category", "minutes",
      "servings", "instructions", "notes"
    ]) {
      form.elements.namedItem(key).value = recipe[key] ?? "";
    }
    currentPhotos = await listPhotos(recipe);
  }

  drawExistingPhotos();
  $("viewer").close();
  $("editor").showModal();
}

function drawExistingPhotos() {
  $("existingPhotos").replaceChildren();

  for (const photo of currentPhotos) {
    const wrapper = node("div", undefined, "photo-edit");
    const remove = node("button", "Remove", "secondary");
    remove.type = "button";

    remove.addEventListener("click", async () => {
      if (busy || !confirm("Remove this photo?")) return;
      remove.disabled = true;
      try {
        check(await bucket().remove([photo.path]));
        currentPhotos = currentPhotos.filter(p => p.path !== photo.path);
        drawExistingPhotos();
        render();
      } catch (error) {
        $("formMessage").textContent = error.message;
        remove.disabled = false;
      }
    });

    wrapper.append(imageFor(photo, "Existing recipe photo"), remove);
    $("existingPhotos").append(wrapper);
  }
}

function setBusy(value) {
  busy = value;
  for (const control of form.elements) control.disabled = value;
  $("closeEditor").disabled = value;
  for (const button of $("existingPhotos").querySelectorAll("button")) {
    button.disabled = value;
  }
}

async function saveRecipe(event) {
  event.preventDefault();
  if (busy) return;

  const values = new FormData(form);
  const files = Array.from($("files").files);
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

  if (files.some(file => !allowed.has(file.type) || file.size > 8388608)) {
    $("formMessage").textContent =
      "Choose JPG, PNG, or WebP photos no larger than 8 MB each.";
    return;
  }

  if (currentPhotos.length + files.length > 20) {
    $("formMessage").textContent = "Please use up to 20 photos per recipe.";
    return;
  }

  const text = name => String(values.get(name) || "").trim();
  const payload = {
    title: text("title"),
    author: text("author"),
    category: text("category"),
    minutes: text("minutes") === "" ? null : Number(text("minutes")),
    servings: text("servings") === "" ? null : Number(text("servings")),
    ingredients: joinIngredients(values.getAll("ingredient")),
    instructions: text("instructions"),
    notes: text("notes")
  };

  if (!payload.title || !payload.author ||
      !payload.ingredients || !payload.instructions) {
    $("formMessage").textContent = "Fill in the recipe name, author, ingredients, and instructions.";
    return;
  }

  if (payload.ingredients.length > 20000) {
    $("formMessage").textContent = "Your ingredients are too long. Please use fewer than 20,000 characters in total.";
    return;
  }

  setBusy(true);
  $("formMessage").textContent = "Saving recipe…";
  let recipeSaved = false;

  try {
    let recipe;

    if (editing) {
      recipe = check(await db.from("recipes")
        .update(payload)
        .eq("id", editing.id)
        .select()
        .single());
    } else {
      recipe = check(await db.from("recipes")
        .insert({ ...payload, owner_id: user.id })
        .select()
        .single());
    }

    // Retain the ID even if a later upload fails, preventing duplicate recipes.
    editing = recipe;
    recipeSaved = true;

    const failed = [];

    for (const file of files) {
      const extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp"
      }[file.type];

      const path =
        `${user.id}/${recipe.id}/${crypto.randomUUID()}.${extension}`;

      const result = await bucket().upload(path, file, {
        contentType: file.type,
        upsert: false
      });

      if (result.error) failed.push(file.name);
    }

    $("files").value = "";
    await loadRecipes();

    if (failed.length) {
      currentPhotos = await listPhotos(recipe);
      drawExistingPhotos();
      $("formMessage").textContent =
        `Recipe saved. These photos failed; select them again to retry:\n${failed.join("\n")}`;
      return;
    }

    $("editor").close();
    status("Recipe saved. Another family favorite for the book.");
  } catch (error) {
    $("formMessage").textContent =
      `${recipeSaved ? "The recipe was saved, but a later step failed. " : ""}${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function deleteRecipe() {
  if (!selected || !confirm(`Delete "${selected.title}" and its photos?`)) return;

  $("delete").disabled = true;
  try {
    // Remove files first so a failed removal can be retried.
    const photos = await listPhotos(selected);
    if (photos.length) {
      check(await bucket().remove(photos.map(photo => photo.path)));
    }

    check(await db.from("recipes")
      .delete()
      .eq("id", selected.id)
      .select()
      .single());

    $("viewer").close();
    selected = null;
    await loadRecipes();
    status("Recipe deleted.");
  } catch (error) {
    status(error.message);
  } finally {
    $("delete").disabled = false;
  }
}

async function refreshSession() {
  const version = ++sessionVersion;
  const session = check(await db.auth.getSession()).session;
  user = session?.user ?? null;

  $("book").hidden = true;
  $("accountNav").hidden = true;
  $("familySection").hidden = true;
  $("login").hidden = Boolean(user);
  $("logout").hidden = !user;

  if (!user) {
    profiles = [];
    profileOwner = null;
    avatarCache.clear();
    $("familyGrid").replaceChildren();
    $("profileBanner").replaceChildren();
    $("profileEditor").close();
    recipes = [];
    generation++;
    $("recipes").replaceChildren();
    return;
  }

  const member = check(await db.from("family_members")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle());

  if (!member) {
    status("Your account hasn’t been given cookbook access yet. Ask the cookbook owner to add you.");
    return;
  }

  // Create a profile for this account without exposing its email.
  check(await db.from("profiles").upsert(
    { user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true }
  ));
  const loadedProfiles = check(await db.from("profiles").select("*")
    .order("display_name"));
  if (version !== sessionVersion) return;
  profiles = loadedProfiles;
  $("accountNav").hidden = false;
  $("book").hidden = false;
  status("");
  await loadRecipes();
  if (version !== sessionVersion) return;
  if (!profiles.find(p => p.user_id === user.id)?.display_name && !$("profileEditor").open) {
    editMyProfile();
  }
}

async function start() {
  if (SUPABASE_URL.startsWith("YOUR_") || SUPABASE_KEY.startsWith("YOUR_")) {
    status("Setup needed: add your Supabase URL and publishable key to app.js.");
    return;
  }

  db = createClient(SUPABASE_URL, SUPABASE_KEY);
  $("addIngredient").addEventListener("click", () => addIngredientBox("", true));
  $("allRecipes").addEventListener("click", () => showProfile(null));
  $("familyNav").addEventListener("click", () => {
    $("book").hidden = true;
    $("familySection").hidden = false;
    renderFamily();
  });
  $("myProfile").addEventListener("click", () => showProfile(user.id));
  $("closeProfileEditor").addEventListener("click", () => $("profileEditor").close());
  $("profileEditor").addEventListener("cancel", event => {
    if (profileBusy) event.preventDefault();
  });
  $("profileForm").addEventListener("submit", saveProfile);

  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;

    try {
      check(await db.auth.signInWithOtp({
        email: $("email").value.trim(),
        options: {
          shouldCreateUser: false,
          emailRedirectTo: location.origin + location.pathname
        }
      }));
      status("Check your email for a sign-in link. Only invited accounts can sign in.");
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("logout").addEventListener("click", async () => {
    try {
      check(await db.auth.signOut());
      $("viewer").close();
      $("editor").close();
      await refreshSession();
      status("Signed out.");
    } catch (error) {
      status(error.message);
    }
  });

  $("add").addEventListener("click", () =>
    openEditor().catch(error => status(error.message)));

  $("edit").addEventListener("click", () =>
    openEditor(selected).catch(error => status(error.message)));

  $("delete").addEventListener("click", deleteRecipe);
  $("closeViewer").addEventListener("click", () => $("viewer").close());
  $("closeEditor").addEventListener("click", () => $("editor").close());
  $("editor").addEventListener("cancel", event => {
    if (busy) event.preventDefault();
  });
  $("print").addEventListener("click", () => window.print());
  $("search").addEventListener("input", render);
  $("filter").addEventListener("change", render);
  form.addEventListener("submit", saveRecipe);

  db.auth.onAuthStateChange(event => {
    if (["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) {
      setTimeout(() => {
        refreshSession().catch(error => status(error.message));
      }, 0);
    }
  });

  await refreshSession();
}


function profileName(id) {
  return profiles.find(profile => profile.user_id === id)?.display_name || "Family member";
}

function profileButton(id) {
  const button = node("button", `Added by ${profileName(id)}`, "profile-link");
  button.type = "button";
  button.addEventListener("click", () => {
    $("viewer").close();
    showProfile(id);
  });
  return button;
}

function avatar(profile) {
  const holder = node("div", (profile.display_name || "?").slice(0, 1).toUpperCase(), "avatar");
  if (profile.avatar_path) {
    const path = profile.avatar_path;
    let pending = avatarCache.get(path);
    if (!pending) {
      pending = db.storage.from("profile-photos").createSignedUrl(path, 300)
        .then(check).catch(error => { avatarCache.delete(path); throw error; });
      avatarCache.set(path, pending);
      setTimeout(() => avatarCache.delete(path), 240000);
    }
    pending.then(data => {
      if (!user || !holder.isConnected) return;
      const image = imageFor({ url: data.signedUrl }, `${profile.display_name || "Family member"}'s profile picture`);
      image.addEventListener("error", () => image.remove());
      holder.append(image);
    }).catch(() => {});
  }
  return holder;
}

function renderFamily() {
  $("familyGrid").replaceChildren();
  for (const profile of profiles) {
    const card = node("article", undefined, "card card-body");
    const count = recipes.filter(recipe => recipe.owner_id === profile.user_id).length;
    const button = node("button", "View profile", "secondary");
    button.addEventListener("click", () => showProfile(profile.user_id));
    card.append(avatar(profile), node("h3", profile.display_name || "Family member"),
      node("p", `${count} recipe${count === 1 ? "" : "s"}`, "muted"), button);
    $("familyGrid").append(card);
  }
  renderProfileBanner();
}

function renderProfileBanner() {
  $("profileBanner").replaceChildren();
  $("profileBanner").hidden = !profileOwner;
  $("bookIntro").hidden = Boolean(profileOwner);
  if (!profileOwner) return;
  const profile = profiles.find(p => p.user_id === profileOwner);
  if (!profile) return;
  const count = recipes.filter(recipe => recipe.owner_id === profileOwner).length;
  $("profileBanner").append(avatar(profile),
    node("h1", profile.display_name || "Family member"),
    node("p", `${count} recipe${count === 1 ? "" : "s"} shared with the family`));
  if (profileOwner === user?.id) {
    const edit = node("button", "Edit my profile", "secondary");
    edit.addEventListener("click", editMyProfile);
    $("profileBanner").append(edit);
  }
}

function showProfile(id) {
  profileOwner = id;
  $("search").value = "";
  $("filter").value = "";
  $("familySection").hidden = true;
  $("book").hidden = false;
  render();
}

function editMyProfile() {
  const profile = profiles.find(p => p.user_id === user.id);
  $("profileName").value = profile?.display_name || "";
  $("profilePicture").value = "";
  $("removeAvatar").checked = false;
  $("profileMessage").textContent = "";
  $("profileEditor").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  if (profileBusy) return;
  const displayName = $("profileName").value.trim();
  const file = $("profilePicture").files[0];
  if (!displayName) {
    $("profileMessage").textContent = "Enter the name you want your family to see.";
    return;
  }
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  if (file && (!extensions[file.type] || file.size > 5242880)) {
    $("profileMessage").textContent = "Choose a JPG, PNG, or WebP picture under 5 MB.";
    return;
  }
  const accountId = user.id;
  const oldPath = profiles.find(p => p.user_id === accountId)?.avatar_path;
  let newPath = null;
  let saved = false;
  profileBusy = true;
  for (const field of $("profileForm").elements) field.disabled = true;
  $("closeProfileEditor").disabled = true;
  $("logout").disabled = true;
  $("profileMessage").textContent = "Saving profile…";
  try {
    let path = $("removeAvatar").checked ? null : (oldPath || null);
    if (file) {
      newPath = `${accountId}/${crypto.randomUUID()}.${extensions[file.type]}`;
      check(await db.storage.from("profile-photos").upload(newPath, file, {
        contentType: file.type, upsert: false
      }));
      path = newPath;
    }
    const profile = check(await db.from("profiles").update({
      display_name: displayName, avatar_path: path
    }).eq("user_id", accountId).select().single());
    saved = true;
    profiles = profiles.map(p => p.user_id === accountId ? profile : p);
    if (oldPath && oldPath !== path) {
      // Saving the new profile succeeds independently of old-image cleanup.
      await db.storage.from("profile-photos").remove([oldPath]);
      avatarCache.delete(oldPath);
    }
    $("profileEditor").close();
    render();
    status("Your profile has been saved.");
  } catch (error) {
    if (newPath && !saved) await db.storage.from("profile-photos").remove([newPath]);
    $("profileMessage").textContent = error.message;
  } finally {
    profileBusy = false;
    for (const field of $("profileForm").elements) field.disabled = false;
    $("closeProfileEditor").disabled = false;
    $("logout").disabled = false;
  }
}

start().catch(error => status(error.message));
