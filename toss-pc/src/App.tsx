import React, { useState, useEffect, useRef } from 'react';
import { supabase } from './lib/supabase';
import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { Power, Trash2, Copy, CheckCheck, Paperclip, Inbox, DownloadCloud } from 'lucide-react';
import './App.css';

// Batas maksimal ukuran file yang boleh diupload
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

type NoteStatus = 'sending' | 'sent' | 'error';

interface TossNote {
  id: string;
  type: 'text' | 'file';
  content: string;
  created_at: string;
  // Field lokal saja (tidak ada di DB), dipakai untuk optimistic UI
  status?: NoteStatus;
  localId?: string;
  errorMessage?: string;
}

function App() {
  const [notes, setNotes] = useState<TossNote[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Menu klik-kanan untuk hapus pesan: null = tertutup
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; note: TossNote } | null>(null);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);

  const listAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Simpan referensi File asli per localId, supaya tombol Retry bisa
  // mengunggah ulang file yang sama tanpa user pilih file lagi
  const pendingFilesRef = useRef<Map<string, File>>(new Map());

  // Tutup context menu begitu user klik di mana pun di layar
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);

    // Inisialisasi Tauri plugins (aman untuk gagal jika di browser biasa)
    const initTauriPlugins = async () => {
      try {
        const autostart = await isEnabled();
        setAutoStartEnabled(autostart);
        
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
          const permission = await requestPermission();
          permissionGranted = permission === 'granted';
        }
      } catch (err) {
        console.warn('Tauri plugins not available', err);
      }
    };
    initTauriPlugins();

    return () => window.removeEventListener('click', closeMenu);
  }, []);

  // Fetch data awal (sekali saja) + subscribe granular ke INSERT/DELETE
  useEffect(() => {
    fetchInitialNotes();

    const channel = supabase
      .channel('toss_notes_channel')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'toss_notes' }, (payload) => {
        const newNote = payload.new as TossNote;
        let isNewFromOtherDevice = false;

        setNotes((prev) => {
          // Kalau id ini sudah ada (hasil insert kita sendiri), jangan dobel
          if (prev.some((n) => n.id === newNote.id)) return prev;
          isNewFromOtherDevice = true;
          return [...prev, { ...newNote, status: 'sent' }];
        });

        // Trigger notifikasi native
        setTimeout(() => {
          if (isNewFromOtherDevice && !document.hasFocus()) {
            try {
              isPermissionGranted().then(granted => {
                if (granted) {
                  sendNotification({
                    title: 'Pesan Toss Baru',
                    body: newNote.type === 'text' ? newNote.content : 'File baru diterima',
                  });
                }
              });
            } catch(e) {}
          }
        }, 100);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'toss_notes' }, (payload) => {
        const oldNote = payload.old as TossNote;
        setNotes((prev) => prev.filter((n) => n.id !== oldNote.id));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Auto-scroll ke bawah setiap notes berubah
  useEffect(() => {
    if (listAreaRef.current) {
      listAreaRef.current.scrollTop = listAreaRef.current.scrollHeight;
    }
  }, [notes]);

  const fetchInitialNotes = async () => {
    const { data, error } = await supabase
      .from('toss_notes')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching notes:', error);
    } else if (data) {
      setNotes(data.map((n) => ({ ...n, status: 'sent' as NoteStatus })));
    }
  };

  const toggleAutoStart = async () => {
    try {
      if (autoStartEnabled) {
        await disable();
        setAutoStartEnabled(false);
      } else {
        await enable();
        setAutoStartEnabled(true);
      }
    } catch (err) {
      console.error('Failed to toggle autostart', err);
    }
  };

  const generateLocalId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ============ TEXT SUBMIT ============
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = inputText.trim();
    if (!text || isSubmitting) return;

    setIsSubmitting(true);
    setInputText('');

    const localId = generateLocalId();
    const optimisticNote: TossNote = {
      id: localId,
      type: 'text',
      content: text,
      created_at: new Date().toISOString(),
      status: 'sending',
      localId,
    };
    setNotes((prev) => [...prev, optimisticNote]);

    await sendTextNote(localId, text);
    setIsSubmitting(false);
  };

  const sendTextNote = async (localId: string, text: string) => {
    const { data, error } = await supabase
      .from('toss_notes')
      .insert([{ type: 'text', content: text }])
      .select()
      .single();

    if (error || !data) {
      console.error('Error inserting note:', error);
      setNotes((prev) =>
        prev.map((n) =>
          n.localId === localId ? { ...n, status: 'error', errorMessage: 'Gagal mengirim teks' } : n
        )
      );
      return;
    }

    // Ganti entry optimistic dengan data asli dari server
    setNotes((prev) => prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n)));
  };

  const retryTextNote = async (note: TossNote) => {
    if (!note.localId) return;
    setNotes((prev) =>
      prev.map((n) => (n.localId === note.localId ? { ...n, status: 'sending', errorMessage: undefined } : n))
    );
    await sendTextNote(note.localId, note.content);
  };

  // ============ FILE UPLOAD ============
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input segera supaya file yang sama bisa dipilih lagi nanti
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (file.size > MAX_FILE_SIZE_BYTES) {
      alert(`File terlalu besar (maks 15MB). Ukuran file: ${(file.size / 1024 / 1024).toFixed(1)}MB`);
      return;
    }

    const localId = generateLocalId();
    pendingFilesRef.current.set(localId, file);

    const optimisticNote: TossNote = {
      id: localId,
      type: 'file',
      content: '',
      created_at: new Date().toISOString(),
      status: 'sending',
      localId,
    };
    setNotes((prev) => [...prev, optimisticNote]);

    await uploadFile(localId, file);
  };

  const uploadFile = async (localId: string, file: File) => {
    setIsUploading(true);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

      const { error: uploadError } = await supabase.storage.from('toss_files').upload(fileName, file);
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('toss_files').getPublicUrl(fileName);
      const publicUrl = publicUrlData.publicUrl;

      const { data, error: insertError } = await supabase
        .from('toss_notes')
        .insert([{ type: 'file', content: publicUrl }])
        .select()
        .single();
      
      if (insertError || !data) {
        // Rollback: Hapus file yang terlanjur di-upload ke Storage jika insert DB gagal
        try {
          await supabase.storage.from('toss_files').remove([fileName]);
        } catch (rollbackErr) {
          console.error('Failed to rollback orphaned file:', rollbackErr);
        }
        throw insertError || new Error('Gagal menyimpan ke database');
      }

      pendingFilesRef.current.delete(localId);
      setNotes((prev) => prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n)));
    } catch (error: any) {
      console.error('Upload error:', error);
      setNotes((prev) =>
        prev.map((n) =>
          n.localId === localId
            ? { ...n, status: 'error', errorMessage: error.message || 'Gagal mengunggah file' }
            : n
        )
      );
    } finally {
      setIsUploading(false);
    }
  };

  const retryFileUpload = async (note: TossNote) => {
    if (!note.localId) return;
    const file = pendingFilesRef.current.get(note.localId);
    if (!file) {
      alert('File asli tidak lagi tersimpan di memori. Silakan upload ulang secara manual.');
      setNotes((prev) => prev.filter((n) => n.localId !== note.localId));
      return;
    }
    setNotes((prev) =>
      prev.map((n) => (n.localId === note.localId ? { ...n, status: 'sending', errorMessage: undefined } : n))
    );
    await uploadFile(note.localId, file);
  };

  // ============ DELETE ============
  const handleContextMenu = (e: React.MouseEvent, note: TossNote) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, note });
  };

  const handleDeleteNote = async (note: TossNote) => {
    if (note.localId) {
      pendingFilesRef.current.delete(note.localId);
    }

    // Hapus dari layar dulu (optimistic), baru hapus dari server
    setNotes((prev) => prev.filter((n) => (n.localId || n.id) !== (note.localId || note.id)));

    // Kalau note ini belum pernah sukses ter-insert ke DB (masih 'sending'/'error'),
    // tidak ada row untuk dihapus di server
    if (note.status !== 'sent') return;

    const { error } = await supabase.from('toss_notes').delete().eq('id', note.id);
    if (error) {
      console.error('Gagal menghapus note:', error);
      alert('Gagal menghapus pesan, coba lagi.');
      // Kembalikan ke state kalau delete di server gagal
      setNotes((prev) =>
        [...prev, note].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      );
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isImageFile = (url: string) => /\.(jpeg|jpg|gif|png|webp)(\?.*)?$/i.test(url);

  const getFileNameFromUrl = (url: string) => {
    const parts = url.split('/');
    const lastPart = parts[parts.length - 1];
    return decodeURIComponent(lastPart.split('?')[0]);
  };

  return (
    <div className="toss-app-container">
      {/* HEADER */}
      <header className="toss-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Toss</h1>
        <button 
          onClick={toggleAutoStart}
          style={{ 
            fontSize: '12px', padding: '6px 10px', borderRadius: '6px', 
            cursor: 'pointer', background: autoStartEnabled ? '#10b981' : '#4b5563', 
            color: 'white', border: 'none', fontWeight: 'bold' 
          }}
          title={autoStartEnabled ? 'Auto-start saat Windows menyala (Aktif)' : 'Auto-start saat Windows menyala (Mati)'}
        >
          <Power size={14} style={{ marginRight: '6px' }} />
          {autoStartEnabled ? 'Auto-Start: ON' : 'Auto-Start: OFF'}
        </button>
      </header>

      {/* LIST AREA */}
      <main className="toss-list-area" ref={listAreaRef}>
        {notes.length === 0 ? (
          <div className="empty-state">
            <Inbox size={48} color="#64748b" style={{ marginBottom: '12px' }} />
            <p>Belum ada apa-apa di sini.</p>
            <p className="empty-state-sub">Coba lempar teks atau file dari device lain.</p>
          </div>
        ) : (
          notes.map((note) => (
            <div
              key={note.localId || note.id}
              className={`toss-card ${note.status === 'error' ? 'toss-card-error' : ''}`}
              onContextMenu={(e) => handleContextMenu(e, note)}
            >
              {/* RENDER CONTENT BERDASARKAN STATUS & TIPE */}
              {note.status === 'sending' && note.type === 'file' ? (
                <div className="upload-placeholder">Mengunggah file...</div>
              ) : note.type === 'file' && note.content ? (
                isImageFile(note.content) ? (
                  <img src={note.content} alt="Tossed file" className="toss-image" />
                ) : (
                  <a href={note.content} target="_blank" rel="noopener noreferrer" className="toss-file-link" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <DownloadCloud size={16} />
                    Download File ({getFileNameFromUrl(note.content).substring(14)})
                  </a>
                )
              ) : (
                <div className="toss-card-content">{note.content}</div>
              )}

              <div className="toss-card-footer">
                {note.status === 'error' ? (
                  <>
                    <span className="toss-card-error-text">{note.errorMessage || 'Gagal terkirim'}</span>
                    <button
                      className="btn-retry"
                      onClick={() => (note.type === 'text' ? retryTextNote(note) : retryFileUpload(note))}
                    >
                      Retry
                    </button>
                  </>
                ) : (
                  <>
                    <span className="toss-card-time">
                      {note.status === 'sending' ? 'Mengirim...' : formatTime(note.created_at)}
                    </span>
                    {note.status !== 'sending' && note.type === 'text' && (
                      <button
                        className={`btn-copy ${copiedId === note.id ? 'copied' : ''}`}
                        onClick={() => handleCopy(note.id, note.content)}
                        title="Copy to clipboard"
                        style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {copiedId === note.id ? <CheckCheck size={14} /> : <Copy size={14} />}
                        {copiedId === note.id ? 'Copied' : 'Copy'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </main>

      {/* INPUT AREA */}
      <footer className="toss-input-area">
        {/* Hidden File Input */}
        <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileUpload} />

        {/* Attachment Button */}
        <button
          className="btn-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          title="Upload file or photo (maks 15MB)"
        >
          {isUploading ? (
            <span style={{ fontSize: '12px' }}>...</span>
          ) : (
            <Paperclip size={18} />
          )}
        </button>
        <textarea
          className="toss-textarea"
          placeholder="Ketik atau paste teks di sini..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isSubmitting}
        />
        <button className="btn-submit" onClick={handleSubmit} disabled={!inputText.trim() || isSubmitting}>
          {isSubmitting ? '...' : 'Toss'}
        </button>
      </footer>

      {/* CONTEXT MENU (klik kanan untuk hapus) */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item context-menu-delete"
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            onClick={() => {
              handleDeleteNote(contextMenu.note);
              setContextMenu(null);
            }}
          >
            <Trash2 size={14} /> Hapus Pesan
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
