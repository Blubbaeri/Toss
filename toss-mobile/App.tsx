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
  ScrollView,
  LayoutAnimation,
  UIManager,
  Animated,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { supabase } from './src/lib/supabase';

// Batas maksimal ukuran file yang boleh diupload
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

type NoteStatus = 'sending' | 'sent' | 'error' | 'deleting';

// Aktifkan LayoutAnimation di Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Konfigurasi Bouncy Spring yang unik untuk entrance/exit
const CustomLayoutAnimation = {
  duration: 400,
  create: {
    type: LayoutAnimation.Types.spring,
    property: LayoutAnimation.Properties.scaleXY,
    springDamping: 0.6,
  },
  update: {
    type: LayoutAnimation.Types.spring,
    springDamping: 0.6,
  },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
};

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

export default function App() {
  const [notes, setNotes] = useState<TossNote[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [filterType, setFilterType] = useState('all');
  const [customDate, setCustomDate] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDate, setTempDate] = useState(new Date());
  const [showDeleteModal, setShowDeleteModal] = useState<TossNote | null>(null);
  const [pendingAsset, setPendingAsset] = useState<{asset: ImagePicker.ImagePickerAsset, localId: string} | null>(null);

  const flatListRef = useRef<FlatList>(null);
  // Simpan asset foto asli per localId, supaya tombol Retry bisa upload ulang
  // tanpa user harus buka galeri lagi
  const pendingAssetsRef = useRef<Map<string, ImagePicker.ImagePickerAsset>>(new Map());

  useEffect(() => {
    fetchInitialNotes();

    const channel = supabase
      .channel('toss_notes_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'toss_notes' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          LayoutAnimation.configureNext(CustomLayoutAnimation);
          setNotes((prev) => {
            if (prev.some((n) => n.id === payload.new.id)) return prev;
            return [...prev, payload.new as TossNote];
          });
        }
        if (payload.eventType === 'DELETE') {
          LayoutAnimation.configureNext(CustomLayoutAnimation);
          setNotes((prev) => prev.filter((n) => n.id !== payload.old.id));
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchInitialNotes = async () => {
    try {
      const { data, error } = await supabase
        .from('toss_notes')
        .select('*')
        .order('created_at', { ascending: true });
      if (data) {
        LayoutAnimation.configureNext(CustomLayoutAnimation);
        setNotes(data.map((n) => ({ ...n, status: 'sent' as NoteStatus })));
      }
    } catch (err) {
      console.error(err);
    }

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

  const generateLocalId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ============ TEXT & IMAGE SUBMIT ============
  const handleSubmit = async () => {
    const text = inputText.trim();
    if ((!text && !pendingAsset) || isSubmitting) return;

    setIsSubmitting(true);
    setInputText('');

    if (pendingAsset) {
      const { asset, localId } = pendingAsset;
      pendingAssetsRef.current.set(localId, asset);
      setPendingAsset(null); // Clear preview

      const optimisticNote: TossNote = {
        id: localId,
        type: 'file',
        content: '',
        caption: text,
        created_at: new Date().toISOString(),
        status: 'sending',
        localId,
      };
      LayoutAnimation.configureNext(CustomLayoutAnimation);
      setNotes((prev) => [...prev, optimisticNote]);
      await uploadImageToSupabase(localId, asset, text);
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
      LayoutAnimation.configureNext(CustomLayoutAnimation);
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
          n.localId === localId ? { ...n, status: 'error', errorMessage: 'Gagal mengirim teks' } : n
        )
      );
      return;
    }

    setNotes((prev) => {
      if (prev.some((n) => n.id === data.id && !n.localId)) {
        return prev.filter((n) => n.localId !== localId);
      }
      return prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n));
    });
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
      Alert.alert('Permission denied', 'You must allow gallery access to upload photos.');
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
      Alert.alert('File too large', `Max 15MB. Photo size: ${(asset.fileSize / 1024 / 1024).toFixed(1)}MB`);
      return;
    }

    const localId = generateLocalId();
    setPendingAsset({ asset, localId });
  };

  const uploadImageToSupabase = async (localId: string, asset: ImagePicker.ImagePickerAsset, caption?: string) => {
    setIsUploading(true);
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: 'base64',
      });

      const approxSize = Math.round(base64.length * 3 / 4);
      if (approxSize > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File too large (${(approxSize / 1024 / 1024).toFixed(1)}MB). Max 15MB.`);
      }

      const arrayBuffer = decode(base64);

      const fileExt = asset.uri.split('.').pop()?.split('?')[0] || 'jpg';
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

      const { error: uploadError } = await supabase.storage.from('toss_files').upload(fileName, arrayBuffer, {
        contentType: `image/${fileExt === 'jpg' ? 'jpeg' : fileExt}`,
      });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('toss_files').getPublicUrl(fileName);

      const insertData: any = { type: 'file', content: publicUrlData.publicUrl };
      if (caption) insertData.caption = caption;

      const { data, error: insertError } = await supabase
        .from('toss_notes')
        .insert([insertData])
        .select()
        .single();
        
      if (insertError || !data) {
        try {
          await supabase.storage.from('toss_files').remove([fileName]);
        } catch (rollbackErr) {
          console.error('Failed to rollback orphaned file:', rollbackErr);
        }
        throw insertError || new Error('Failed to save to database');
      }

      pendingAssetsRef.current.delete(localId);
      setNotes((prev) => {
        if (prev.some((n) => n.id === data.id && !n.localId)) {
          return prev.filter((n) => n.localId !== localId);
        }
        return prev.map((n) => (n.localId === localId ? { ...data, status: 'sent' } : n));
      });
    } catch (error: any) {
      console.error('Upload error:', error);
      setNotes((prev) =>
        prev.map((n) =>
          n.localId === localId
            ? { ...n, status: 'error', errorMessage: error.message || 'Failed to upload photo' }
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
      Alert.alert('Retry Failed', 'Original photo is no longer in memory. Please upload manually again.');
      setNotes((prev) => prev.filter((n) => n.localId !== note.localId));
      return;
    }
    setNotes((prev) =>
      prev.map((n) => (n.localId === note.localId ? { ...n, status: 'sending', errorMessage: undefined } : n))
    );
    await uploadImageToSupabase(note.localId, asset, note.caption);
  };

  // ============ DELETE ============
  const handleDeleteNote = async (note: TossNote) => {
    if (note.status === 'sending' || note.status === 'deleting') return;
    
    // Animasikan status 'deleting'
    LayoutAnimation.configureNext(CustomLayoutAnimation);
    setNotes((prev) => prev.map((n) => (n.localId || n.id) === (note.localId || note.id) ? { ...n, status: 'deleting' } : n));
    
    try {
      const { error } = await supabase.from('toss_notes').delete().eq('id', note.id);
      
      // Kasih jeda sedikit agar loading animation delete terlihat
      await new Promise(r => setTimeout(r, 400));
      
      if (!error) {
        LayoutAnimation.configureNext(CustomLayoutAnimation);
        setNotes((prev) => prev.filter((n) => (n.localId || n.id) !== (note.localId || note.id)));
      } else {
        LayoutAnimation.configureNext(CustomLayoutAnimation);
        setNotes((prev) => prev.map((n) => (n.localId || n.id) === (note.localId || note.id) ? { ...n, status: 'sent', errorMessage: 'Gagal dihapus' } : n));
      }
    } catch (err) {
      LayoutAnimation.configureNext(CustomLayoutAnimation);
      setNotes((prev) => prev.map((n) => (n.localId || n.id) === (note.localId || note.id) ? { ...n, status: 'sent', errorMessage: 'Gagal dihapus' } : n));
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

  const getOneMonthAgoDateObj = () => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d;
  };

  const handleDateChange = (event: any, selectedDate?: Date) => {
    setShowDatePicker(Platform.OS === 'ios');
    if (selectedDate) {
      setTempDate(selectedDate);
      const isoStr = selectedDate.toISOString().split('T')[0];
      setCustomDate(isoStr);
    }
  };

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

  const renderItem = ({ item }: { item: TossNote }) => {
    const isSending = item.status === 'sending';
    const isDeleting = item.status === 'deleting';
    const opacity = isSending || isDeleting ? 0.6 : 1;

    return (
      <Pressable style={[{ opacity }]}>
        <View style={[styles.card, item.status === 'error' && styles.cardError, (isSending || isDeleting) && { borderColor: '#3b82f6', borderWidth: 1 }]}>
          {(isSending || isDeleting) && (
            <View style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}>
              <ActivityIndicator color="#3b82f6" size="small" />
            </View>
          )}

          {/* RENDER CONTENT BERDASARKAN STATUS & TIPE */}
          {item.status === 'sending' && item.type === 'file' ? (
            <View style={styles.uploadPlaceholder}>
              <ActivityIndicator color="#94a3b8" size="small" />
              <Text style={styles.uploadPlaceholderText}>Uploading photo...</Text>
            </View>
          ) : item.type === 'file' && item.content ? (
            <View>
              {isImageFile(item.content) ? (
                <Image source={{ uri: item.content }} style={styles.cardImage} resizeMode="cover" />
              ) : (
                <TouchableOpacity style={[styles.fileLinkButton, { flexDirection: 'row', alignItems: 'center', gap: 6 }]} onPress={() => Linking.openURL(item.content)}>
                  <Feather name="download-cloud" size={16} color="#3b82f6" />
                  <Text style={styles.fileLinkText}>Download: {getFileNameFromUrl(item.content)}</Text>
                </TouchableOpacity>
              )}
              {item.caption && (
                <View style={{ marginTop: 8, padding: 10, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8 }}>
                  <Text style={{ color: '#f1f5f9', fontSize: 14 }}>{item.caption}</Text>
                </View>
              )}
            </View>
          ) : (
            <Text style={styles.cardContent}>{item.content}</Text>
          )}

          <View style={styles.cardFooter}>
            {item.status === 'error' ? (
              <>
                <Text style={styles.cardErrorText}>{item.errorMessage || 'Failed to send'}</Text>
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
                  {item.status === 'sending' ? 'Sending...' : isDeleting ? 'Deleting...' : formatTime(item.created_at)}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {item.type === 'text' && (
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
                  {/* Delete Button (Mobile) */}
                  <TouchableOpacity
                    style={[styles.btnCopy, { borderColor: '#f87171' }]}
                    onPress={() => handleDeleteNote(item)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.copyText, { color: '#f87171' }]}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Pressable>
    );
  };

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
              placeholder="Search..."
              placeholderTextColor="#94a3b8"
              value={searchTerm}
              onChangeText={setSearchTerm}
            />
          </View>
          <TouchableOpacity style={styles.sortButton} onPress={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}>
            <Feather name={sortOrder === 'asc' ? 'arrow-down' : 'arrow-up'} size={16} color="#f1f5f9" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.sortButton} onPress={fetchInitialNotes}>
            <Feather name="refresh-cw" size={16} color="#60a5fa" />
          </TouchableOpacity>
        </View>

        {/* CHIP FILTERS */}
        <View style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(255, 255, 255, 0.08)' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipContainer}>
            {['all', 'today', 'yesterday', '7days', 'month', 'custom'].map(type => {
              const labels: Record<string, string> = {
                all: 'All Time', today: 'Today', yesterday: 'Yesterday', '7days': 'Last 7 Days', month: 'This Month', custom: 'Choose Date'
              };
              return (
                <TouchableOpacity
                  key={type}
                  style={[styles.chip, filterType === type && styles.chipActive]}
                  onPress={() => {
                    setFilterType(type);
                    if (type === 'custom') {
                      setShowDatePicker(true);
                    } else {
                      setCustomDate('');
                      setShowDatePicker(false);
                    }
                  }}
                >
                  <Text style={[styles.chipText, filterType === type && styles.chipTextActive]}>
                    {labels[type]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          
          {showDatePicker && (
            <DateTimePicker
              value={tempDate}
              mode="date"
              display="default"
              minimumDate={getOneMonthAgoDateObj()}
              maximumDate={new Date()}
              onChange={handleDateChange}
            />
          )}

          {filterType === 'custom' && customDate ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
              <Text style={{ color: '#60a5fa', fontSize: 13, fontWeight: '600' }}>
                Selected: {customDate}
              </Text>
            </View>
          ) : null}
        </View>

        {/* LIST AREA */}
        <View style={styles.listArea}>
          {notes.length === 0 ? (
            <View style={styles.emptyState}>
              <Feather name="inbox" size={48} color="#64748b" style={{ marginBottom: 12 }} />
              <Text style={styles.emptyStateTitle}>No items found.</Text>
              <Text style={styles.emptyStateSub}>Try tossing text or files from another device.</Text>
            </View>
          ) : filteredNotes.length === 0 ? (
            <View style={styles.emptyState}>
              <Feather name="file-minus" size={48} color="#64748b" style={{ marginBottom: 12, opacity: 0.5 }} />
              <Text style={styles.emptyStateTitle}>No results found.</Text>
              <Text style={styles.emptyStateSub}>No messages match your current filter.</Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={filteredNotes}
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
        <View style={{ backgroundColor: 'rgba(15, 23, 42, 0.95)', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)' }}>
          {pendingAsset && (
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: '#1e293b', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Image source={{ uri: pendingAsset.asset.uri }} style={{ width: 36, height: 36, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.2)' }} />
                <Text style={{ color: '#cbd5e1', fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
                  {pendingAsset.asset.fileName || 'Image selected'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setPendingAsset(null)} style={{ padding: 4 }}>
                <Feather name="trash-2" size={16} color="#f87171" />
              </TouchableOpacity>
            </View>
          )}
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
              placeholder={pendingAsset ? 'Type a caption or comment...' : 'Type a message...'}
              placeholderTextColor="#94a3b8"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={2000}
              editable={!isSubmitting}
            />
            <TouchableOpacity
              style={[styles.btnSubmit, ((!inputText.trim() && !pendingAsset) || isSubmitting) && styles.btnSubmitDisabled]}
              onPress={handleSubmit}
              disabled={(!inputText.trim() && !pendingAsset) || isSubmitting}
              activeOpacity={0.8}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.btnSubmitText}>Toss</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* DELETE MODAL */}
      <Modal transparent visible={!!showDeleteModal} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Delete Message?</Text>
            <Text style={styles.modalDesc}>This message will be deleted from all devices.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.btnModalCancel} onPress={() => setShowDeleteModal(null)}>
                <Text style={styles.btnModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnModalDelete} onPress={() => {
                if (showDeleteModal) handleDeleteNote(showDeleteModal);
                setShowDeleteModal(null);
              }}>
                <Text style={styles.btnModalDeleteText}>Delete</Text>
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
  chipContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  chipActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
    borderColor: '#3b82f6',
  },
  chipText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#60a5fa',
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
