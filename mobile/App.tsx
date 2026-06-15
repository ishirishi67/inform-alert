import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  api,
  BASE,
  SEED_USERS,
  type CallLogEntry,
  type Message,
  type User,
  type WeeklyTodo,
} from "./src/api";

type Screen =
  | { name: "login" }
  | { name: "home" }
  | { name: "chat"; other: User }
  | { name: "activity" };

export default function App() {
  const [me, setMe] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "login" });
  const [members, setMembers] = useState<User[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  // live messages arrive here; the chat screen merges them in
  const [incoming, setIncoming] = useState<Message | null>(null);
  const ws = useRef<WebSocket | null>(null);

  // Connect WebSocket after login (for live messages + presence).
  useEffect(() => {
    if (!me) return;
    api.circle(me.id).then((r) => setMembers(r.members)).catch(() => {});
    const sock = new WebSocket(`${BASE.replace("https", "wss")}/ws?userId=${me.id}`);
    sock.onmessage = (e) => {
      try {
        const { type, payload } = JSON.parse(e.data);
        if (type === "presence") setOnline(payload.online);
        else if (type === "message:new" || type === "message:update")
          setIncoming(payload as Message);
      } catch {}
    };
    ws.current = sock;
    return () => sock.close();
  }, [me]);

  if (!me || screen.name === "login") {
    return (
      <SafeAreaView style={[styles.app, styles.center]}>
        <StatusBar style="light" />
        <Text style={styles.logo}>InformAlert</Text>
        <Text style={styles.muted}>Who's using this phone?</Text>
        {SEED_USERS.map((u) => (
          <Pressable
            key={u.id}
            style={styles.bigChip}
            onPress={() => {
              setMe(u);
              setScreen({ name: "home" });
            }}
          >
            <Text style={styles.bigChipText}>
              {u.avatar}  {u.name}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.tiny}>The call announces the person, not the phone.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {me.avatar} {me.name}
        </Text>
        <Pressable
          onPress={() => {
            setMe(null);
            setScreen({ name: "login" });
          }}
        >
          <Text style={styles.link}>Switch</Text>
        </Pressable>
      </View>

      {screen.name === "home" && (
        <HomeScreen
          members={members}
          online={online}
          onOpenChat={(u) => setScreen({ name: "chat", other: u })}
          onOpenActivity={() => setScreen({ name: "activity" })}
        />
      )}
      {screen.name === "chat" && (
        <ChatScreen
          me={me}
          other={screen.other}
          incoming={incoming}
          onBack={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "activity" && (
        <ActivityScreen me={me} onBack={() => setScreen({ name: "home" })} />
      )}
    </SafeAreaView>
  );
}

function HomeScreen({
  members,
  online,
  onOpenChat,
  onOpenActivity,
}: {
  members: User[];
  online: string[];
  onOpenChat: (u: User) => void;
  onOpenActivity: () => void;
}) {
  return (
    <View style={styles.flex}>
      <Pressable style={styles.row} onPress={onOpenActivity}>
        <Text style={styles.rowText}>📋  History &amp; To-dos</Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      <Text style={styles.sectionLabel}>FAMILY</Text>
      <FlatList
        data={members}
        keyExtractor={(u) => u.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onOpenChat(item)}>
            <View style={[styles.dot, online.includes(item.id) && styles.dotOn]} />
            <Text style={styles.rowText}>
              {item.avatar}  {item.name}
            </Text>
            <Pressable
              hitSlop={12}
              onPress={() => Linking.openURL(BASE)}
              style={styles.callBtn}
            >
              <Text style={styles.callBtnText}>📞</Text>
            </Pressable>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function ChatScreen({
  me,
  other,
  incoming,
  onBack,
}: {
  me: User;
  other: User;
  incoming: Message | null;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    api.messages(me.id, other.id).then((r) => setMessages(r.messages)).catch(() => {});
  }, [me.id, other.id]);

  // Merge live messages/updates for this thread.
  useEffect(() => {
    if (!incoming) return;
    const tid = [me.id, other.id].sort().join(":");
    if (incoming.threadId !== tid) return;
    setMessages((m) => {
      const i = m.findIndex((x) => x.id === incoming.id);
      if (i >= 0) {
        const copy = m.slice();
        copy[i] = incoming;
        return copy;
      }
      return [...m, incoming];
    });
  }, [incoming]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    try {
      const { message } = await api.sendMessage(me.id, other.id, body);
      setMessages((m) => [...m, message]);
    } catch {}
  };

  return (
    <View style={styles.flex}>
      <Pressable style={styles.subHeader} onPress={onBack}>
        <Text style={styles.link}>‹ Back</Text>
        <Text style={styles.subHeaderTitle}>
          {other.avatar} {other.name}
        </Text>
        <View style={{ width: 50 }} />
      </Pressable>

      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 6 }}
        renderItem={({ item }) => (
          <View
            style={[
              styles.bubble,
              item.senderId === me.id ? styles.bubbleMine : styles.bubbleTheirs,
            ]}
          >
            {item.kind === "recording" ? (
              <RecordingBubble m={item} />
            ) : (
              <Text style={styles.bubbleText}>
                {item.kind === "quick_reply" ? "⚡ " : ""}
                {item.body}
              </Text>
            )}
          </View>
        )}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message…"
          placeholderTextColor="#8696a0"
          onSubmitEditing={send}
        />
        <Pressable style={styles.sendBtn} onPress={send}>
          <Text style={styles.sendBtnText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RecordingBubble({ m }: { m: Message }) {
  const [showTranscript, setShowTranscript] = useState(false);
  return (
    <View>
      <Pressable onPress={() => m.mediaUrl && Linking.openURL(BASE + m.mediaUrl)}>
        <Text style={styles.bubbleText}>🎥  Play recording</Text>
      </Pressable>
      {!!m.body && <Text style={styles.bubbleText}>{m.body}</Text>}
      {!!m.summary && <Text style={styles.summaryText}>✨ {m.summary}</Text>}
      {!!m.transcript && (
        <View>
          <Pressable onPress={() => setShowTranscript((s) => !s)}>
            <Text style={styles.transcriptToggle}>
              📄 {showTranscript ? "Hide transcript" : "Show transcript"}
            </Text>
          </Pressable>
          {showTranscript && (
            <Text style={styles.transcriptBody}>{m.transcript}</Text>
          )}
        </View>
      )}
    </View>
  );
}

function ActivityScreen({ me, onBack }: { me: User; onBack: () => void }) {
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [todo, setTodo] = useState<WeeklyTodo | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api.history(me.id).then((r) => setCalls(r.calls)).catch(() => {});
    api.todos(me.id).then((r) => setTodo(r.todos[0] ?? null)).catch(() => {});
  }, [me.id]);

  const generate = async () => {
    setLoading(true);
    setNote(null);
    try {
      const { todo: t, note: n } = await api.generateTodos(me.id);
      if (t) setTodo(t);
      else if (n) setNote(n);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't generate");
    } finally {
      setLoading(false);
    }
  };

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <View style={styles.flex}>
      <Pressable style={styles.subHeader} onPress={onBack}>
        <Text style={styles.link}>‹ Back</Text>
        <Text style={styles.subHeaderTitle}>History &amp; To-dos</Text>
        <View style={{ width: 50 }} />
      </Pressable>

      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>✨ This week's to-dos</Text>
            <Pressable style={styles.sendBtn} onPress={generate} disabled={loading}>
              <Text style={styles.sendBtnText}>{loading ? "…" : "Generate"}</Text>
            </Pressable>
          </View>
          {note && <Text style={styles.errorText}>{note}</Text>}
          {todo ? (
            <Text style={styles.summaryText}>{todo.content}</Text>
          ) : (
            !note && (
              <Text style={styles.muted}>
                Generate a to-do list from this week's calls and messages.
              </Text>
            )
          )}
        </View>

        <Text style={styles.sectionLabel}>CALL HISTORY</Text>
        {calls.length === 0 ? (
          <Text style={styles.muted}>No calls yet.</Text>
        ) : (
          calls.map((c) => (
            <View key={c.id} style={styles.logRow}>
              <Text style={styles.bubbleText}>
                {c.type === "video" ? "🎥" : "📞"}{" "}
                {c.direction === "outgoing" ? "↗" : "↘"}{" "}
                {c.other ? `${c.other.avatar} ${c.other.name}` : "—"}
              </Text>
              <Text style={styles.muted}>{fmt(c.startedAt)}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#0b141a" },
  flex: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  logo: { color: "#00a884", fontSize: 34, fontWeight: "800", marginBottom: 6 },
  muted: { color: "#8696a0", fontSize: 14 },
  tiny: { color: "#8696a0", fontSize: 12, marginTop: 16, textAlign: "center" },
  bigChip: {
    backgroundColor: "#202c33",
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 14,
    marginTop: 8,
    width: 220,
    alignItems: "center",
  },
  bigChipText: { color: "#e9edef", fontSize: 20, fontWeight: "600" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#111b21",
  },
  headerTitle: { color: "#e9edef", fontSize: 18, fontWeight: "700" },
  link: { color: "#00a884", fontSize: 15, width: 50 },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#111b21",
  },
  subHeaderTitle: { color: "#e9edef", fontSize: 17, fontWeight: "700" },
  sectionLabel: {
    color: "#8696a0",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#202c33",
  },
  rowText: { color: "#e9edef", fontSize: 17, flex: 1 },
  callBtn: {
    backgroundColor: "#202c33",
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
  },
  callBtnText: { fontSize: 18 },
  chevron: { color: "#8696a0", fontSize: 22 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#8696a0" },
  dotOn: { backgroundColor: "#00a884" },
  bubble: { padding: 10, borderRadius: 10, maxWidth: "82%" },
  bubbleMine: { backgroundColor: "#005c4b", alignSelf: "flex-end" },
  bubbleTheirs: { backgroundColor: "#202c33", alignSelf: "flex-start" },
  bubbleText: { color: "#e9edef", fontSize: 15 },
  summaryText: { color: "#cfe9e0", fontSize: 13, marginTop: 6, lineHeight: 18 },
  transcriptToggle: { color: "#00a884", fontSize: 12, marginTop: 6 },
  transcriptBody: {
    color: "#cdd6db",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
    backgroundColor: "rgba(0,0,0,0.28)",
    borderRadius: 8,
    padding: 8,
  },
  errorText: { color: "#e57373", fontSize: 13, marginTop: 6 },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    backgroundColor: "#111b21",
  },
  input: {
    flex: 1,
    backgroundColor: "#202c33",
    color: "#e9edef",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: "#00a884",
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  sendBtnText: { color: "#fff", fontWeight: "700" },
  card: {
    backgroundColor: "#111b21",
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#202c33",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  cardTitle: { color: "#e9edef", fontSize: 15, fontWeight: "700" },
  logRow: {
    backgroundColor: "#111b21",
    borderRadius: 8,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
