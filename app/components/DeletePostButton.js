"use client";

import { deletePostAction } from "@/lib/actions";

export default function DeletePostButton({ postId }) {
  return (
    <form
      action={deletePostAction.bind(null, postId)}
      onSubmit={(e) => {
        if (!confirm("정말 이 글을 삭제하시겠습니까? 되돌릴 수 없습니다.")) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit" className="danger">삭제</button>
    </form>
  );
}
