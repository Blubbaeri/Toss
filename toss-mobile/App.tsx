import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  Image,
  Linking,
  Alert,
  Pressable,
  Modal,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { supabase } from './src/lib/supabase';

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

export default function App() {
  const [notes, setNotes] = useState<TossNote[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [filterDate, setFilterDate] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState<TossNote | null>(null);

  const flatListRef = useRef<FlatList>(null);
  // Simpan asset foto asli per localId, supaya tombol Retry bisa upload ulang
  // tanpa user harus buka galeri lagi
  const pendingAssetsRef = useRef<Map<string, ImagePicker.ImagePickerAsset>>(new Map());

  useEffect(() => {
    fetchInitialNotes();

    const channel = supabase
      .channel('toss_notes_channel')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'toss_notes' }, (payload) => {
        const newNote = payload.new as TossNote;
        setNotes((prev) => {
          if (prev.some((n) => n.id === newNote.id)) return prev;
          return [...prev, { ...newNote, status: 'sent' }];
        });
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

  const generateLocalId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ============ TEXT SUBMIT ============
  const handleSubmit = async () => {
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

    setNotes((prev) => prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n)));
  };

  const retryTextNote = async (note: TossNote) => {
    if (!note.localId) return;
    setNotes((prev) =>
      prev.map((n) => (n.localId === note.localId ? { ...n, status: 'sending', errorMessage: undefined } : n))
    );
    await sendTextNote(note.localId, note.content);
  };

  // ============ IMAGE UPLOAD ============
  const handlePickImage = async () => {
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permissionResult.granted === false) {
      Alert.alert('Izin ditolak', 'Anda harus mengizinkan akses galeri untuk mengunggah foto.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8,
      base64: false,
    });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];

    // Validasi cepat kalau fileSize sudah tersedia dari picker
    if (asset.fileSize && asset.fileSize > MAX_FILE_SIZE_BYTES) {
      Alert.alert('File terlalu besar', `Maks 15MB. Ukuran foto: ${(asset.fileSize / 1024 / 1024).toFixed(1)}MB`);
      return;
    }

    const localId = generateLocalId();
    pendingAssetsRef.current.set(localId, asset);

    const optimisticNote: TossNote = {
      id: localId,
      type: 'file',
      content: '',
      created_at: new Date().toISOString(),
      status: 'sending',
      localId,
    };
    setNotes((prev) => [...prev, optimisticNote]);

    await uploadImageToSupabase(localId, asset);
  };

  const uploadImageToSupabase = async (localId: string, asset: ImagePicker.ImagePickerAsset) => {
    setIsUploading(true);
    try {
      const response = await fetch(asset.uri);
      const blob = await response.blob();

      // Double-check ukuran blob asli, jaga-jaga kalau fileSize dari picker
      // tidak tersedia (beberapa versi Android/iOS tidak selalu mengisinya)
      if (blob.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File terlalu besar (${(blob.size / 1024 / 1024).toFixed(1)}MB). Maks 15MB.`);
      }

      const fileExt = asset.uri.split('.').pop()?.split('?')[0] || 'jpg';
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

      const { error: uploadError } = await supabase.storage.from('toss_files').upload(fileName, blob, {
        contentType: `image/${fileExt === 'jpg' ? 'jpeg' : fileExt}`,
      });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('toss_files').getPublicUrl(fileName);

      const { data, error: insertError } = await supabase
        .from('toss_notes')
        .insert([{ type: 'file', content: publicUrlData.publicUrl }])
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

      pendingAssetsRef.current.delete(localId);
      setNotes((prev) => prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n)));
    } catch (error: any) {
      console.error('Upload error:', error);
      setNotes((prev) =>
        prev.map((n) =>
          n.localId === localId
            ? { ...n, status: 'error', errorMessage: error.message || 'Gagal mengunggah foto' }
            : n
        )
      );
    } finally {
      setIsUploading(false);
    }
  };

  const retryImageUpload = async (note: TossNote) => {
    if (!note.localId) return;
    const asset = pendingAssetsRef.current.get(note.localId);
    if (!asset) {
      Alert.alert('Gagal Retry', 'Foto asli tidak lagi tersimpan di memori. Silakan upload ulang secara manual.');
      setNotes((prev) => prev.filter((n) => n.localId !== note.localId));
      return;
    }
    setNotes((prev) =>
      prev.map((n) => (n.localId === note.localId ? { ...n, status: 'sending', errorMessage: undefined } : n))
    );
    await uploadImageToSupabase(note.localId, asset);
  };

  // ============ DELETE ============
  const handleDeleteNote = async (note: TossNote) => {
    if (note.localId) {
      pendingAssetsRef.current.delete(note.localId);
    }

    // Hapus dari layar dulu (optimistic), baru hapus dari server
    setNotes((prev) => prev.filter((n) => (n.localId || n.id) !== (note.localId || note.id)));

    // Kalau note ini belum pernah sukses ter-insert ke DB (masih 'sending'/'error'),
    // tidak ada row untuk dihapus di server
    if (note.status !== 'sent') return;

    const { error } = await supabase.from('toss_notes').delete().eq('id', note.id);
    if (error) {
      console.error('Gagal menghapus note:', error);
      Alert.alert('Gagal', 'Gagal menghapus pesan, coba lagi.');
      setNotes((prev) =>
        [...prev, note].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      );
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await Clipboard.setStringAsync(text);
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
    return decodeURIComponent(lastPart.split('?')[0]).substring(14);
  };

  const renderItem = ({ item }: { item: TossNote }) => (
    <Pressable
      style={[styles.card, item.status === 'error' && styles.cardError]}
    >
      {/* RENDER CONTENT BERDASARKAN STATUS & TIPE */}
      {item.status === 'sending' && item.type === 'file' ? (
        <View style={styles.uploadPlaceholder}>
          <ActivityIndicator color="#94a3b8" size="small" />
          <Text style={styles.uploadPlaceholderText}>Mengunggah foto...</Text>
        </View>
      ) : item.type === 'file' && item.content ? (
        isImageFile(item.content) ? (
          <Image source={{ uri: item.content }} style={styles.cardImage} resizeMode="cover" />
        ) : (
          <TouchableOpacity style={[styles.fileLinkButton, { flexDirection: 'row', alignItems: 'center', gap: 6 }]} onPress={() => Linking.openURL(item.content)}>
            <Feather name="download-cloud" size={16} color="#3b82f6" />
            <Text style={styles.fileLinkText}>Download: {getFileNameFromUrl(item.content)}</Text>
          </TouchableOpacity>
        )
      ) : (
        <Text style={styles.cardContent}>{item.content}</Text>
      )}

      <View style={styles.cardFooter}>
        {item.status === 'error' ? (
          <>
            <Text style={styles.cardErrorText}>{item.errorMessage || 'Gagal terkirim'}</Text>
            <TouchableOpacity
              style={styles.btnRetry}
              onPress={() => (item.type === 'text' ? retryTextNote(item) : retryImageUpload(item))}
            >
              <Text style={styles.btnRetryText}>Retry</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.cardTime}>
              {item.status === 'sending' ? 'Mengirim...' : formatTime(item.created_at)}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {item.status !== 'sending' && (
                <TouchableOpacity
                  style={[styles.btnCopy, { borderColor: 'rgba(248,113,113,0.3)' }]}
                  onPress={() => setShowDeleteModal(item)}
                >
                  <Feather name="trash-2" size={14} color="#f87171" />
                </TouchableOpacity>
              )}
              {item.status !== 'sending' && item.type === 'text' && (
                <TouchableOpacity
                  style={[styles.btnCopy, copiedId === item.id && styles.btnCopied]}
                  onPress={() => handleCopy(item.id, item.content)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.copyText, copiedId === item.id && styles.copiedText]}>
                    {copiedId === item.id ? 'Copied' : 'Copy'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <KeyboardAvoidingView style={styles.container} behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        {/* HEADER */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Toss</Text>
        </View>

        {/* TOOLBAR */}
        <View style={styles.toolbar}>
          <View style={styles.searchContainer}>
            <Feather name="search" size={16} color="#94a3b8" />
            <TextInput
              style={styles.searchInput}
              placeholder="Cari..."
              placeholderTextColor="#94a3b8"
              value={searchTerm}
              onChangeText={setSearchTerm}
            />
          </View>
          <TextInput
            style={styles.dateInput}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#94a3b8"
            value={filterDate}
            onChangeText={setFilterDate}
            maxLength={10}
          />
          <TouchableOpacity style={styles.sortButton} onPress={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}>
            <Feather name={sortOrder === 'asc' ? 'arrow-down' : 'arrow-up'} size={16} color="#f1f5f9" />
          </TouchableOpacity>
        </View>

        {/* LIST AREA */}
        <View style={styles.listArea}>
          {notes.length === 0 ? (
            <View style={styles.emptyState}>
              <Feather name="inbox" size={48} color="#64748b" style={{ marginBottom: 12 }} />
              <Text style={styles.emptyStateTitle}>Belum ada apa-apa di sini.</Text>
              <Text style={styles.emptyStateSub}>Coba lempar teks atau file dari device lain.</Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={notes
                .filter((note) => {
                  const matchSearch = note.content.toLowerCase().includes(searchTerm.toLowerCase());
                  const matchDate = filterDate ? note.created_at.startsWith(filterDate) : true;
                  return matchSearch && matchDate;
                })
                .sort((a, b) => {
                  const timeA = new Date(a.created_at).getTime();
                  const timeB = new Date(b.created_at).getTime();
                  return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
                })
              }
              keyExtractor={(item) => item.localId || item.id}
              renderItem={renderItem}
              contentContainerStyle={styles.flatListContent}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
              onLayout={() => flatListRef.current?.scrollToEnd({ animated: true })}
            />
          )}
        </View>

        {/* INPUT AREA */}
        <View style={styles.inputArea}>
          <TouchableOpacity style={styles.btnAttach} onPress={handlePickImage} disabled={isUploading}>
            {isUploading ? (
              <ActivityIndicator color="#94a3b8" size="small" />
            ) : (
              <Feather name="paperclip" size={20} color="#f1f5f9" />
            )}
          </TouchableOpacity>
          <TextInput
            style={styles.textInput}
            placeholder="Ketik pesan..."
            placeholderTextColor="#94a3b8"
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={2000}
            editable={!isSubmitting}
          />
          <TouchableOpacity
            style={[styles.btnSubmit, (!inputText.trim() || isSubmitting) && styles.btnSubmitDisabled]}
            onPress={handleSubmit}
            disabled={!inputText.trim() || isSubmitting}
            activeOpacity={0.8}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnSubmitText}>Toss</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* DELETE MODAL */}
      <Modal transparent visible={!!showDeleteModal} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Hapus Pesan?</Text>
            <Text style={styles.modalDesc}>Pesan ini akan terhapus dari semua perangkat Anda.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.btnModalCancel} onPress={() => setShowDeleteModal(null)}>
                <Text style={styles.btnModalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnModalDelete} onPress={() => {
                if (showDeleteModal) handleDeleteNote(showDeleteModal);
                setShowDeleteModal(null);
              }}>
                <Text style={styles.btnModalDeleteText}>Hapus</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    zIndex: 10,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#60a5fa',
    letterSpacing: 0.5,
  },
  toolbar: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    gap: 8,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  searchInput: {
    flex: 1,
    color: '#f1f5f9',
    fontSize: 13,
    paddingVertical: 8,
    paddingLeft: 8,
  },
  dateInput: {
    width: 100,
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    color: '#f1f5f9',
    fontSize: 13,
    paddingHorizontal: 10,
    textAlign: 'center',
  },
  sortButton: {
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    width: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listArea: {
    flex: 1,
  },
  flatListContent: {
    padding: 16,
    gap: 12,
  },
  emptyState: {
    alignItems: 'center',
    marginTop: 60,
    paddingHorizontal: 32,
  },
  emptyStateIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyStateTitle: {
    color: '#f1f5f9',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptyStateSub: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center',
  },
  card: {
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardError: {
    borderColor: 'rgba(248, 113, 113, 0.4)',
    backgroundColor: 'rgba(127, 29, 29, 0.25)',
  },
  cardContent: {
    fontSize: 15,
    lineHeight: 22,
    color: '#f1f5f9',
    marginBottom: 12,
  },
  cardImage: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    marginBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  uploadPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
    justifyContent: 'center',
    marginBottom: 12,
  },
  uploadPlaceholderText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  fileLinkButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    marginBottom: 12,
  },
  fileLinkText: {
    color: '#3b82f6',
    fontWeight: '500',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTime: {
    fontSize: 12,
    color: '#94a3b8',
  },
  cardErrorText: {
    fontSize: 12,
    color: '#f87171',
    flex: 1,
    marginRight: 8,
  },
  btnRetry: {
    backgroundColor: 'rgba(248, 113, 113, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.4)',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  btnRetryText: {
    color: '#f87171',
    fontSize: 12,
    fontWeight: '600',
  },
  btnCopy: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  btnCopied: {
    backgroundColor: 'rgba(52, 211, 153, 0.1)',
    borderColor: 'rgba(52, 211, 153, 0.3)',
  },
  copyText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  copiedText: {
    color: '#34d399',
  },
  inputArea: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'flex-end',
    gap: 10,
  },
  btnAttach: {
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachIconText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#f1f5f9',
  },
  textInput: {
    flex: 1,
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    color: '#f1f5f9',
    fontSize: 15,
    minHeight: 48,
    maxHeight: 120,
    textAlignVertical: 'top',
  },
  btnSubmit: {
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    height: 48,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnSubmitDisabled: {
    backgroundColor: 'rgba(59, 130, 246, 0.5)',
  },
  btnSubmitText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 15,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#1e293b',
    padding: 24,
    borderRadius: 16,
    width: '80%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  modalTitle: {
    color: '#f1f5f9',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 8,
    textAlign: 'center',
  },
  modalDesc: {
    color: '#94a3b8',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  btnModalCancel: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  btnModalCancelText: {
    color: '#f1f5f9',
    fontWeight: '600',
  },
  btnModalDelete: {
    backgroundColor: 'rgba(248,113,113,0.15)',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.4)',
  },
  btnModalDeleteText: {
    color: '#f87171',
    fontWeight: '600',
  },
});
