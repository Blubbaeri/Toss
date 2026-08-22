import React, { useState, useEffect, useRef } from 'react';
import { supabase } from './lib/supabase';
import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { Power, Trash2, Copy, CheckCheck, Paperclip, Inbox, DownloadCloud, Search, ArrowUp, ArrowDown, FileQuestion } from 'lucide-react';
import './App.css';

// Batas maksimal ukuran file yang boleh diupload
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

type NoteStatus = 'sending' | 'sent' | 'error';

interface TossNote {
  id: string;
  type: 'text' | 'file';
  content: string;
  caption?: string;
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
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);

  // Fitur Filter, Sort, Search, dan Delete Modal
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [filterType, setFilterType] = useState('all');
  const [customDate, setCustomDate] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState<TossNote | null>(null);
  const [pendingFile, setPendingFile] = useState<{file: File, localId: string} | null>(null);

  const listAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Simpan referensi File asli per localId, supaya tombol Retry bisa
  // mengunggah ulang file yang sama tanpa user pilih file lagi
  const pendingFilesRef = useRef<Map<string, File>>(new Map());

  // Tutup konteks/modal jika butuh global listener
  useEffect(() => {

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
                    title: 'New Toss Message',
                    body: newNote.type === 'text' ? newNote.content : 'New file received',
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
    // Hanya fetch data 1 bulan terakhir
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const oneMonthAgoIso = oneMonthAgo.toISOString();

    const { data, error } = await supabase
      .from('toss_notes')
      .select('*')
      .gte('created_at', oneMonthAgoIso)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching notes:', error);
    } else if (data) {
      setNotes(data.map((n) => ({ ...n, status: 'sent' as NoteStatus })));
    }

    // Jalankan pembersihan DB background (hapus data > 3 bulan)
    cleanupOldData();
  };

  const cleanupOldData = async () => {
    try {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      await supabase.from('toss_notes').delete().lt('created_at', threeMonthsAgo.toISOString());
    } catch (err) {
      console.error('Failed to cleanup old data', err);
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

  // ============ TEXT & FILE SUBMIT ============
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = inputText.trim();
    if ((!text && !pendingFile) || isSubmitting) return;

    setIsSubmitting(true);
    setInputText('');

    if (pendingFile) {
      const { file, localId } = pendingFile;
      pendingFilesRef.current.set(localId, file);
      setPendingFile(null); // Clear preview

      const optimisticNote: TossNote = {
        id: localId,
        type: 'file',
        content: '',
        caption: text,
        created_at: new Date().toISOString(),
        status: 'sending',
        localId,
      };
      setNotes((prev) => [...prev, optimisticNote]);
      await uploadFile(localId, file, text);
    } else {
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
    }

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
          n.localId === localId ? { ...n, status: 'error', errorMessage: 'Failed to send text' } : n
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
      alert(`File too large (max 15MB). File size: ${(file.size / 1024 / 1024).toFixed(1)}MB`);
      return;
    }

    const localId = generateLocalId();
    setPendingFile({ file, localId });
  };

  const uploadFile = async (localId: string, file: File, caption?: string) => {
    setIsUploading(true);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

      const { error: uploadError } = await supabase.storage.from('toss_files').upload(fileName, file);
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('toss_files').getPublicUrl(fileName);
      const publicUrl = publicUrlData.publicUrl;

      const insertData: any = { type: 'file', content: publicUrl };
      if (caption) insertData.caption = caption;

      const { data, error: insertError } = await supabase
        .from('toss_notes')
        .insert([insertData])
        .select()
        .single();
      
      if (insertError || !data) {
        // Rollback: Hapus file yang terlanjur di-upload ke Storage jika insert DB gagal
        try {
          await supabase.storage.from('toss_files').remove([fileName]);
        } catch (rollbackErr) {
          console.error('Failed to rollback orphaned file:', rollbackErr);
        }
        throw insertError || new Error('Failed to save to database');
      }

      pendingFilesRef.current.delete(localId);
      setNotes((prev) => prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n)));
    } catch (error: any) {
      console.error('Upload error:', error);
      setNotes((prev) =>
        prev.map((n) =>
          n.localId === localId
            ? { ...n, status: 'error', errorMessage: error.message || 'Failed to upload file' }
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
      alert('Original file is no longer in memory. Please upload manually again.');
      setNotes((prev) => prev.filter((n) => n.localId !== note.localId));
      return;
    }
    setNotes((prev) =>
      prev.map((n) => (n.localId === note.localId ? { ...n, status: 'sending', errorMessage: undefined } : n))
    );
    await uploadFile(note.localId, file, note.caption);
  };

  // ============ DELETE ============
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
      console.error('Failed to delete note:', error);
      alert('Failed to delete message, please try again.');
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

  const getOneMonthAgoDate = () => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().split('T')[0];
  };
  const getTodayDate = () => new Date().toISOString().split('T')[0];

  const filteredNotes = notes
    .filter((note) => {
      const matchSearch = note.content.toLowerCase().includes(searchTerm.toLowerCase());
      
      let matchDate = true;
      if (filterType !== 'all') {
        const noteDate = new Date(note.created_at);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const noteDay = new Date(noteDate);
        noteDay.setHours(0, 0, 0, 0);
        
        if (filterType === 'today') {
          matchDate = noteDay.getTime() === today.getTime();
        } else if (filterType === 'yesterday') {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          matchDate = noteDay.getTime() === yesterday.getTime();
        } else if (filterType === '7days') {
          const sevenDaysAgo = new Date(today);
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          matchDate = noteDay.getTime() >= sevenDaysAgo.getTime();
        } else if (filterType === 'month') {
          matchDate = noteDate.getMonth() === today.getMonth() && noteDate.getFullYear() === today.getFullYear();
        } else if (filterType === 'custom' && customDate) {
          matchDate = note.created_at.startsWith(customDate);
        }
      }
      
      return matchSearch && matchDate;
    })
    .sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

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
          title={autoStartEnabled ? 'Auto-start on Windows boot (Enabled)' : 'Auto-start on Windows boot (Disabled)'}
        >
          <Power size={14} style={{ marginRight: '6px' }} />
          {autoStartEnabled ? 'Auto-Start: ON' : 'Auto-Start: OFF'}
        </button>
      </header>

      {/* TOOLBAR: Search, Filter, Sort */}
      <div className="toss-toolbar" style={{ display: 'flex', gap: '8px', padding: '10px 24px', background: 'var(--header-bg)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '10px', color: '#94a3b8' }} />
          <input 
            type="text" 
            placeholder="Search messages..." 
            value={searchTerm} 
            onChange={e => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '8px 10px 8px 30px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'white', fontSize: '13px' }}
          />
        </div>
        <select 
          value={filterType}
          onChange={e => {
            setFilterType(e.target.value);
            if (e.target.value !== 'custom') setCustomDate('');
          }}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'white', fontSize: '13px', outline: 'none' }}
        >
          <option value="all">All Time</option>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="7days">Last 7 Days</option>
          <option value="month">This Month</option>
          <option value="custom">Choose Date...</option>
        </select>
        {filterType === 'custom' && (
          <input 
            type="date"
            min={getOneMonthAgoDate()}
            max={getTodayDate()}
            value={customDate}
            onChange={e => setCustomDate(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'white', fontSize: '13px', colorScheme: 'dark' }}
          />
        )}
        <button 
          onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'white', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
          title="Sort messages"
        >
          {sortOrder === 'asc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
        </button>
      </div>

      {/* LIST AREA */}
      <main className="toss-list-area" ref={listAreaRef}>
        {notes.length === 0 ? (
          <div className="empty-state">
            <Inbox size={48} color="#64748b" style={{ marginBottom: '12px' }} />
            <p>No items found.</p>
            <p className="empty-state-sub">Try tossing text or files from another device.</p>
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="empty-state">
            <FileQuestion size={48} color="#64748b" style={{ marginBottom: '12px', opacity: 0.5 }} />
            <p>No results found.</p>
            <p className="empty-state-sub">No messages match your current filter.</p>
          </div>
        ) : (
          filteredNotes.map((note) => (
            <div
              key={note.localId || note.id}
              className={`toss-card ${note.status === 'error' ? 'toss-card-error' : ''}`}
            >
              {/* RENDER CONTENT BERDASARKAN STATUS & TIPE */}
              {note.status === 'sending' && note.type === 'file' ? (
                <div className="upload-placeholder">Uploading file...</div>
              ) : note.type === 'file' && note.content ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {isImageFile(note.content) ? (
                    <img src={note.content} alt="Tossed file" className="toss-image" />
                  ) : (
                    <a href={note.content} target="_blank" rel="noopener noreferrer" className="toss-file-link" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <DownloadCloud size={16} />
                      Download File ({getFileNameFromUrl(note.content).substring(14)})
                    </a>
                  )}
                  {note.caption && (
                    <div className="toss-file-caption" style={{ marginTop: '8px', padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', fontSize: '14px', color: '#f1f5f9' }}>
                      {note.caption}
                    </div>
                  )}
                </div>
              ) : (
                <div className="toss-card-content">{note.content}</div>
              )}

              <div className="toss-card-footer">
                {note.status === 'error' ? (
                  <>
                    <span className="toss-card-error-text">{note.errorMessage || 'Failed to send'}</span>
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
                      {note.status === 'sending' ? 'Sending...' : formatTime(note.created_at)}
                    </span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {note.status !== 'sending' && (
                        <button
                          className="btn-copy"
                          style={{ borderColor: 'rgba(248,113,113,0.3)', color: '#f87171' }}
                          onClick={() => setShowDeleteModal(note)}
                          title="Delete message"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      {note.status !== 'sending' && (
                        <button
                          className={`btn-copy ${copiedId === note.id ? 'copied' : ''}`}
                          onClick={() => handleCopy(note.id, note.content)}
                          title={note.type === 'file' ? 'Copy URL' : 'Copy text'}
                          style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                        >
                          {copiedId === note.id ? <CheckCheck size={14} /> : <Copy size={14} />}
                          {copiedId === note.id ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </main>

      {/* INPUT AREA */}
      <footer className="toss-input-container" style={{ display: 'flex', flexDirection: 'column' }}>
        {pendingFile && (
          <div style={{ padding: '8px 12px', background: '#1e293b', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Paperclip size={14} />
              {pendingFile.file.name}
            </span>
            <button onClick={() => setPendingFile(null)} style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="Cancel upload">
              <Trash2 size={14} />
            </button>
          </div>
        )}
        <div className="toss-input-area" style={{ borderTop: pendingFile ? 'none' : '1px solid var(--border)' }}>
          {/* Hidden File Input */}
          <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileUpload} />

          {/* Attachment Button */}
          <button
            className="btn-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            title="Upload file or photo (max 15MB)"
          >
            {isUploading ? (
              <span style={{ fontSize: '12px' }}>...</span>
            ) : (
              <Paperclip size={18} />
            )}
          </button>
          <textarea
            className="toss-textarea"
            placeholder={pendingFile ? 'Type a caption or comment...' : 'Type or paste text here...'}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isSubmitting}
          />
          <button className="btn-submit" onClick={handleSubmit} disabled={(!inputText.trim() && !pendingFile) || isSubmitting}>
            {isSubmitting ? '...' : 'Toss'}
          </button>
        </div>
      </footer>

      {/* DELETE CONFIRMATION MODAL */}
      {showDeleteModal && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, color: '#f1f5f9' }}>Delete Message?</h3>
            <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '20px' }}>
              This message will be deleted from all devices. This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button className="btn-modal-cancel" onClick={() => setShowDeleteModal(null)}>
                Cancel
              </button>
              <button className="btn-modal-delete" onClick={() => {
                handleDeleteNote(showDeleteModal);
                setShowDeleteModal(null);
              }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
