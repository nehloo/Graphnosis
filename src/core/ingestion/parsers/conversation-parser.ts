import type { ParsedConversation, ConversationMessage, ParsedDocument } from '@/core/types';

// Parse conversation transcripts from multiple formats into the graph pipeline
// Supports: Claude Code, ChatGPT export, Slack export, raw text

export function parseConversation(
  content: string,
  sourceFile: string,
  format?: 'claude' | 'chatgpt' | 'slack' | 'raw'
): ParsedConversation {
  const detected = format || detectFormat(content);

  switch (detected) {
    case 'claude':
      return parseClaude(content, sourceFile);
    case 'chatgpt':
      return parseChatGPT(content, sourceFile);
    case 'slack':
      return parseSlack(content, sourceFile);
    default:
      return parseRaw(content, sourceFile);
  }
}

function detectFormat(content: string): 'claude' | 'chatgpt' | 'slack' | 'raw' {
  if (content.includes('"mapping"') && content.includes('"message"')) return 'chatgpt';
  if (content.includes('"type": "message"') && content.includes('"channel"')) return 'slack';
  // Match role labels in multiple languages/formats
  if (
    content.includes('Human:') || content.includes('Assistant:') ||
    content.includes('User:') || content.includes('System:') ||
    content.includes('Utilisateur:') || content.includes('Humain:') ||  // French
    content.includes('Usuario:') || content.includes('Asistente:') ||   // Spanish
    content.includes('Benutzer:') || content.includes('Assistent:') ||  // German
    content.includes('Utente:') || content.includes('Assistente:') ||   // Italian
    content.includes('Utilizator:') || content.includes('Asistent:') || // Romanian
    content.includes('Пользователь:') || content.includes('Ассистент:') || // Russian
    content.includes('> ')
  ) return 'claude';
  return 'raw';
}

// Claude Code / Claude.ai format: "Human: ...\n\nAssistant: ..."
function parseClaude(content: string, sourceFile: string): ParsedConversation {
  const messages: ConversationMessage[] = [];
  const blocks = content.split(/\n\n(?=(?:Human|Assistant|User|System):)/i);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (/^(?:Human|User):/i.test(trimmed)) {
      messages.push({
        role: 'user',
        content: trimmed.replace(/^(?:Human|User):\s*/i, '').trim(),
      });
    } else if (/^Assistant:/i.test(trimmed)) {
      messages.push({
        role: 'assistant',
        content: trimmed.replace(/^Assistant:\s*/i, '').trim(),
      });
    } else if (/^System:/i.test(trimmed)) {
      messages.push({
        role: 'system',
        content: trimmed.replace(/^System:\s*/i, '').trim(),
      });
    }
  }

  return {
    id: sourceFile,
    title: extractConversationTitle(messages),
    messages,
    sourceFile,
    startedAt: Date.now(),
    format: 'claude',
    metadata: { messageCount: messages.length },
  };
}

// ChatGPT JSON export format
function parseChatGPT(content: string, sourceFile: string): ParsedConversation {
  const messages: ConversationMessage[] = [];

  try {
    const data = JSON.parse(content);

    // ChatGPT exports can be a single conversation or an array
    const conversations = Array.isArray(data) ? data : [data];
    const conv = conversations[0];

    if (conv.mapping) {
      // Navigate the mapping tree
      for (const node of Object.values(conv.mapping) as Array<{ message?: { author: { role: string }; content: { parts: string[] } } }>) {
        if (node.message?.content?.parts) {
          const role = node.message.author.role as 'user' | 'assistant' | 'system';
          const text = node.message.content.parts.join('\n').trim();
          if (text && (role === 'user' || role === 'assistant')) {
            messages.push({ role, content: text });
          }
        }
      }
    }

    return {
      id: conv.id || sourceFile,
      title: conv.title || extractConversationTitle(messages),
      messages,
      sourceFile,
      startedAt: conv.create_time ? conv.create_time * 1000 : Date.now(),
      format: 'chatgpt',
      metadata: { messageCount: messages.length },
    };
  } catch {
    return parseRaw(content, sourceFile);
  }
}

// Slack JSON export format
function parseSlack(content: string, sourceFile: string): ParsedConversation {
  const messages: ConversationMessage[] = [];

  try {
    const data = JSON.parse(content);
    const items = Array.isArray(data) ? data : data.messages || [];

    for (const msg of items) {
      if (msg.text && msg.type === 'message') {
        messages.push({
          role: msg.bot_id ? 'assistant' : 'user',
          content: msg.text,
          timestamp: msg.ts ? parseFloat(msg.ts) * 1000 : undefined,
        });
      }
    }
  } catch {
    return parseRaw(content, sourceFile);
  }

  return {
    id: sourceFile,
    title: extractConversationTitle(messages),
    messages,
    sourceFile,
    startedAt: messages[0]?.timestamp || Date.now(),
    format: 'slack',
    metadata: { messageCount: messages.length },
  };
}

// Fallback: treat each paragraph as alternating user/assistant
function parseRaw(content: string, sourceFile: string): ParsedConversation {
  const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);
  const messages: ConversationMessage[] = paragraphs.map((p, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: p.trim(),
  }));

  return {
    id: sourceFile,
    title: extractConversationTitle(messages),
    messages,
    sourceFile,
    startedAt: Date.now(),
    format: 'raw',
    metadata: { messageCount: messages.length },
  };
}

function extractConversationTitle(messages: ConversationMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return 'Untitled Conversation';
  return firstUser.content.slice(0, 80) + (firstUser.content.length > 80 ? '...' : '');
}

// Convert a parsed conversation into a ParsedDocument for the graph pipeline
export function conversationToDocument(conv: ParsedConversation): ParsedDocument {
  const sections = conv.messages
    .filter(m => m.role !== 'system')
    .map((msg, i) => ({
      title: `${msg.role === 'user' ? 'User' : 'Assistant'} (turn ${Math.floor(i / 2) + 1})`,
      content: msg.content,
      depth: 1,
      children: [],
    }));

  return {
    title: conv.title,
    sections,
    sourceFile: `conversation:${conv.id}`,
    metadata: {
      source: 'conversation',
      format: conv.format,
      messageCount: conv.messages.length,
      startedAt: conv.startedAt,
    },
  };
}
