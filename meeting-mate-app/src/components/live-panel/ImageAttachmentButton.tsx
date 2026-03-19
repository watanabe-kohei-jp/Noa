"use client";

import React, { useRef, useCallback } from "react";
import { ImagePlus } from "lucide-react";
import { resizeImageToBase64 } from "../../lib/image-utils";

interface ImageAttachmentButtonProps {
  onImageReady: (base64: string, mimeType: string) => void;
  onPreview: (previewUrl: string) => void;
  onError: (message: string) => void;
  disabled: boolean;
}

export default function ImageAttachmentButton({
  onImageReady,
  onPreview,
  onError,
  disabled,
}: ImageAttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset input so the same file can be re-selected
      e.target.value = "";

      if (!file.type.startsWith("image/")) {
        onError("画像ファイルを選択してください。");
        return;
      }

      try {
        // Show preview immediately from the raw file
        const previewUrl = URL.createObjectURL(file);
        onPreview(previewUrl);

        // Resize and convert to base64
        const { base64, mimeType } = await resizeImageToBase64(file);
        onImageReady(base64, mimeType);
      } catch (err) {
        onError(err instanceof Error ? err.message : "画像の処理に失敗しました。");
      }
    },
    [onImageReady, onPreview, onError]
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        onClick={handleClick}
        disabled={disabled}
        className={`p-2 rounded-xl transition ${
          disabled
            ? "bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500"
            : "bg-gray-100 text-gray-700 hover:bg-teal-100 hover:text-teal-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-teal-900/30 dark:hover:text-teal-400"
        }`}
        title="画像を送信"
      >
        <ImagePlus size={16} />
      </button>
    </>
  );
}
