import { createClient } from
  "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://ettfsfmlzvgexrkxqvqj.supabase.co/rest/v1/";
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
  const version = ++generation;
  const query = $("search").value.toLowerCase().trim();
  const category = $("filter").value;

  const matches = recipes.filter(recipe =>
    (!category || recipe.category === category) &&
    [
      recipe.title, recipe.author, recipe.ingredients,
      recipe.instructions, recipe.notes
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

async function openEditor(recipe = null) {
  editing = recipe;
  form.reset();
  currentPhotos = [];
  $("existingPhotos").replaceChildren();
  $("formMessage").textContent = "";
  $("editorTitle").textContent = recipe ? "Edit recipe" : "Add a recipe";

  if (recipe) {
    for (const key of [
      "title", "author", "category", "minutes",
      "servings", "ingredients", "instructions", "notes"
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
    ingredients: text("ingredients"),
    instructions: text("instructions"),
    notes: text("notes")
  };

  if (!payload.title || !payload.author ||
      !payload.ingredients || !payload.instructions) {
    $("formMessage").textContent = "Fill in the recipe name, author, ingredients, and instructions.";
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
  const session = check(await db.auth.getSession()).session;
  user = session?.user ?? null;

  $("book").hidden = true;
  $("login").hidden = Boolean(user);
  $("logout").hidden = !user;

  if (!user) {
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

  $("book").hidden = false;
  status("");
  await loadRecipes();
}

async function start() {
  if (SUPABASE_URL.startsWith("YOUR_") || SUPABASE_KEY.startsWith("YOUR_")) {
    status("Setup needed: add your Supabase URL and publishable key to app.js.");
    return;
  }

  db = createClient(SUPABASE_URL, SUPABASE_KEY);

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

start().catch(error => status(error.message));
