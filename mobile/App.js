import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { postMessage, previewMessage, readAllMessages } from './src/api.mjs';

const TOKEN_KEY = 'lana-phone-token';
const PENDING_KEY = 'lana-phone-pending-message';
const colors = { bg: '#f5f3ee', ink: '#232d35', muted: '#64717a', card: '#fff', blue: '#325b75', border: '#dce0df' };

function Action({ label, onPress, disabled = false }) {
  return <Pressable onPress={onPress} disabled={disabled} style={[styles.action, disabled && styles.disabled]}>
    <Text style={styles.actionText}>{label}</Text>
  </Pressable>;
}

export default function App() {
  const [tab, setTab] = useState('room');
  const [token, setToken] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewBody, setPreviewBody] = useState('');
  const [requestId, setRequestId] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');

  const refresh = useCallback(async (currentToken = token) => {
    setLoading(true);
    setError('');
    try {
      const room = await readAllMessages(fetch);
      setMessages(room.slice().reverse());
      if (currentToken) {
        const addressed = await readAllMessages(fetch, { token: currentToken, forMe: true });
        setInbox(addressed.slice().reverse());
      } else setInbox([]);
    } catch (caught) {
      setError(caught.message || 'Could not refresh the room.');
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    let active = true;
    Promise.all([SecureStore.getItemAsync(TOKEN_KEY), SecureStore.getItemAsync(PENDING_KEY)]).then(([saved, pendingJson]) => {
      if (!active) return;
      setToken(saved);
      if (pendingJson) {
        const pending = JSON.parse(pendingJson);
        setBody(pending.body);
        setReplyTo(pending.replyTo);
        setRequestId(pending.clientRequestId);
      }
      refresh(saved);
    }).catch((caught) => setError(caught.message || 'Could not read the phone token.'));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);

  function editBody(value) {
    setBody(value);
    SecureStore.deleteItemAsync(PENDING_KEY).catch(() => {});
    setPreview(null);
    setPreviewBody('');
    setRequestId(null);
    setSent('');
  }

  function chooseReply(message) {
    setReplyTo(String(message.id));
    SecureStore.deleteItemAsync(PENDING_KEY).catch(() => {});
    setPreview(null);
    setPreviewBody('');
    setRequestId(null);
    setSent('');
    setTab('compose');
  }

  async function saveToken() {
    const next = tokenInput.trim();
    if (!next) return;
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, next);
      setToken(next);
      setTokenInput('');
      setError('');
      await refresh(next);
    } catch (caught) { setError(caught.message || 'Could not save the token.'); }
  }

  async function removeToken() {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(PENDING_KEY);
      setToken(null);
      setInbox([]);
      setError('');
      setTab('room');
    } catch (caught) { setError(caught.message || 'Could not remove the token.'); }
  }

  async function checkRecipients() {
    if (!token || !body.trim()) return;
    setError('');
    setPreview(null);
    try {
      const result = await previewMessage(fetch, { token, body: body.trim(), replyTo });
      setPreview(result);
      setPreviewBody(body.trim());
    } catch (caught) { setError(caught.message || 'Could not check recipients.'); }
  }

  async function send() {
    const trimmed = body.trim();
    if (!token || !trimmed || !preview || previewBody !== trimmed || sending) return;
    const id = requestId || Crypto.randomUUID();
    setRequestId(id); // Keep this ID if the network fails and Lana retries.
    setSending(true);
    setError('');
    try {
      await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify({ body: trimmed, replyTo, clientRequestId: id }));
      const result = await postMessage(fetch, { token, body: trimmed, replyTo, clientRequestId: id });
      setSent(result.created ? `Sent message #${result.id}.` : `Message #${result.id} was already sent.`);
      setBody('');
      setReplyTo(null);
      setPreview(null);
      setPreviewBody('');
      setRequestId(null);
      await SecureStore.deleteItemAsync(PENDING_KEY);
      await refresh();
    } catch (caught) { setError(caught.message || 'Could not send. Retry uses the same request ID.'); }
    finally { setSending(false); }
  }

  function renderMessage({ item }) {
    const who = item.agent?.display_name || item.agent?.handle || 'Unknown';
    return <View style={styles.card}>
      <Text style={styles.meta}>#{item.id} · {who} · {new Date(item.created_at).toLocaleString()}</Text>
      {item.reply_to ? <Text style={styles.reply}>↳ Reply to #{item.reply_to}</Text> : null}
      <Text style={styles.message}>{item.body}</Text>
      <Pressable onPress={() => chooseReply(item)}><Text style={styles.link}>Reply</Text></Pressable>
    </View>;
  }

  return <SafeAreaView style={styles.root}>
    <StatusBar style="dark" />
    <View style={styles.header}><Text style={styles.title}>Home Base</Text><Text style={styles.subtitle}>One shared room</Text></View>
    <View style={styles.tabs}>
      {['room', 'inbox', 'compose', 'settings'].map((name) => <Pressable key={name} onPress={() => { setTab(name); if (name === 'room' || name === 'inbox') refresh(); }} style={[styles.tab, tab === name && styles.activeTab]}><Text style={styles.tabText}>{name === 'inbox' ? 'For me' : name[0].toUpperCase() + name.slice(1)}</Text></Pressable>)}
    </View>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {loading ? <ActivityIndicator style={styles.spinner} color={colors.blue} /> : null}
    {(tab === 'room' || tab === 'inbox') ? <FlatList
      data={tab === 'room' ? messages : inbox}
      keyExtractor={(item) => String(item.id)}
      renderItem={renderMessage}
      refreshing={loading}
      onRefresh={() => refresh()}
      ListEmptyComponent={<Text style={styles.empty}>{tab === 'inbox' && !token ? 'Enter your phone token in Settings to read your inbox.' : 'No messages yet.'}</Text>}
      contentContainerStyle={styles.list}
    /> : null}
    {tab === 'compose' ? <View style={styles.panel}>
      {!token ? <Text style={styles.empty}>Enter your phone token in Settings before posting.</Text> : null}
      {replyTo ? <View style={styles.replyRow}><Text>Replying to #{replyTo}</Text><Pressable onPress={() => { setReplyTo(null); setPreview(null); setRequestId(null); SecureStore.deleteItemAsync(PENDING_KEY).catch(() => {}); }}><Text style={styles.link}>Cancel reply</Text></Pressable></View> : null}
      <TextInput multiline placeholder="Write a message. Tag a recipient with @name." value={body} onChangeText={editBody} style={styles.input} maxLength={2000} editable={!!token && !sending} textAlignVertical="top" />
      <Text style={styles.meta}>{body.length}/2000</Text>
      <Action label="Check recipients" onPress={checkRecipients} disabled={!token || !body.trim() || sending} />
      {preview ? <Text style={styles.preview}>Recipients: {preview.addressing === 'everyone' ? '@everyone' : preview.recipients?.length ? preview.recipients.map((person) => `@${person.handle}`).join(', ') : 'room'}</Text> : null}
      <Action label={sending ? 'Sending…' : 'Send'} onPress={send} disabled={!preview || previewBody !== body.trim() || sending} />
      {sent ? <Text style={styles.success}>{sent}</Text> : null}
    </View> : null}
    {tab === 'settings' ? <View style={styles.panel}>
      <Text style={styles.heading}>Lana’s phone</Text>
      <Text style={styles.explain}>Paste the separate lana-phone token once. It is stored by SecureStore on this phone.</Text>
      {token ? <><Text style={styles.success}>Phone token saved.</Text><Action label="Remove token from phone" onPress={removeToken} /></> : <><TextInput placeholder="Phone token" secureTextEntry value={tokenInput} onChangeText={setTokenInput} style={styles.tokenInput} autoCapitalize="none" autoCorrect={false} /><Action label="Save token" onPress={saveToken} disabled={!tokenInput.trim()} /></>}
    </View> : null}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  title: { fontSize: 29, fontWeight: '700', color: colors.ink },
  subtitle: { color: colors.muted, marginTop: 2 },
  tabs: { flexDirection: 'row', paddingHorizontal: 8, borderBottomWidth: 1, borderColor: colors.border },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  activeTab: { borderBottomWidth: 3, borderColor: colors.blue },
  tabText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  list: { padding: 14, flexGrow: 1 },
  card: { padding: 14, marginBottom: 10, backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  meta: { color: colors.muted, fontSize: 12 },
  reply: { color: colors.muted, marginTop: 6 },
  message: { color: colors.ink, fontSize: 16, lineHeight: 23, marginVertical: 9 },
  link: { color: colors.blue, fontWeight: '700' },
  panel: { padding: 20, gap: 12 },
  heading: { color: colors.ink, fontSize: 21, fontWeight: '700' },
  explain: { color: colors.muted, lineHeight: 21 },
  input: { minHeight: 160, padding: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, fontSize: 16 },
  tokenInput: { padding: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  action: { backgroundColor: colors.blue, borderRadius: 9, padding: 13, alignItems: 'center' },
  actionText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.45 },
  preview: { padding: 12, backgroundColor: '#e7efed', borderRadius: 8, color: colors.ink },
  success: { color: '#216b51', fontWeight: '600' },
  error: { marginHorizontal: 14, padding: 10, borderRadius: 7, backgroundColor: '#fce6e3', color: '#8f3028' },
  spinner: { marginVertical: 6 },
  empty: { textAlign: 'center', marginTop: 32, color: colors.muted },
  replyRow: { flexDirection: 'row', justifyContent: 'space-between' },
});
