"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";

export async function loginAction(formData) {
  const password = formData.get("password");

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    redirect("/admin/login?error=1");
  }

  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  redirect("/admin");
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/admin/login");
}

function generateSlug() {
  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ymd}-${rand}`;
}

function readPostFields(formData) {
  return {
    title: (formData.get("title") || "").toString().trim(),
    category: (formData.get("category") || "").toString().trim() || "병원소식",
    excerpt: (formData.get("excerpt") || "").toString().trim(),
    content: (formData.get("content") || "").toString(),
    thumbnail: (formData.get("thumbnail") || "").toString() || null,
    author: (formData.get("author") || "").toString().trim() || "admin",
    published: formData.get("published") === "on",
  };
}

export async function createPostAction(formData) {
  const fields = readPostFields(formData);

  if (!fields.title || !fields.content) {
    redirect("/admin/posts/new?error=1");
  }

  let slug = generateSlug();
  while (await prisma.post.findUnique({ where: { slug } })) {
    slug = generateSlug();
  }

  await prisma.post.create({
    data: { ...fields, slug, excerpt: fields.excerpt || fields.title },
  });

  redirect("/admin");
}

export async function updatePostAction(id, formData) {
  const fields = readPostFields(formData);

  if (!fields.title || !fields.content) {
    redirect(`/admin/posts/${id}/edit?error=1`);
  }

  await prisma.post.update({
    where: { id: Number(id) },
    data: { ...fields, excerpt: fields.excerpt || fields.title },
  });

  redirect("/admin");
}

export async function deletePostAction(id) {
  await prisma.post.delete({ where: { id: Number(id) } });
  redirect("/admin");
}
