let previewEl = null;

function createPreview(src) {
  previewEl = document.createElement('img');
  previewEl.src = src;
  previewEl.className = 'file-thumbnail-hover-preview';
  document.body.appendChild(previewEl);
}

function positionPreview(event) {
  if (!previewEl) {
    return;
  }
  const offset = 16;
  const rect = previewEl.getBoundingClientRect();
  let x = event.clientX + offset;
  let y = event.clientY + offset;
  if (x + rect.width > window.innerWidth) {
    x = event.clientX - rect.width - offset;
  }
  if (y + rect.height > window.innerHeight) {
    y = event.clientY - rect.height - offset;
  }
  previewEl.style.left = `${x}px`;
  previewEl.style.top = `${y}px`;
}

function removePreview() {
  if (previewEl) {
    previewEl.remove();
    previewEl = null;
  }
}

export function initFileThumbnailPreview() {
  const fileBody = document.getElementById('fileBody');
  if (!fileBody) {
    return;
  }

  fileBody.addEventListener('mouseover', (event) => {
    if (!fileBody.classList.contains('file-density-compact')) {
      return;
    }
    const img = event.target.closest('[id^="fileThumbnail-"] img');
    if (!img || previewEl) {
      return;
    }
    createPreview(img.src);
    positionPreview(event);
  });

  fileBody.addEventListener('mousemove', (event) => {
    if (previewEl) {
      positionPreview(event);
    }
  });

  fileBody.addEventListener('mouseout', (event) => {
    const img = event.target.closest('[id^="fileThumbnail-"] img');
    if (img && (!event.relatedTarget || !img.contains(event.relatedTarget))) {
      removePreview();
    }
  });
}
