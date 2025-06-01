const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const UserFileManager = require('./utils/userFileManager');
const { updateSessionName } = require('./handlers/sessionHandler');

// Get userStates from index.js
function getUserStates() {
  return require('./index').userStates;
}

// Tracking reconnect attempts per session
const reconnectAttempts = {};
const MAX_RECONNECT_ATTEMPTS = 3;

// Helper function to check if bot is admin in group - IMPROVED
function isBotAdminInGroup(groupMetadata, botJid, botLid) {
  if (!groupMetadata || !groupMetadata.participants) {
    return false;
  }
  
  // Extract bot number from JID (handle both formats)
  const botNumber = botJid.split('@')[0].split(':')[0];
  const botLidNumber = botLid ? botLid.split('@')[0].split(':')[0] : null;
  
  console.log(`[DEBUG] Checking admin status:`);
  console.log(`[DEBUG] - Bot JID: ${botJid}`);
  console.log(`[DEBUG] - Bot LID: ${botLid}`);
  console.log(`[DEBUG] - Bot numbers: ${botNumber}, ${botLidNumber}`);
  console.log(`[DEBUG] - All participants:`, groupMetadata.participants.map(p => `${p.id} (${p.admin || 'member'})`));
  
  const isAdmin = groupMetadata.participants.some(p => {
    // Must have admin role first
    const hasAdminRole = p.admin === 'admin' || p.admin === 'superadmin';
    if (!hasAdminRole) return false;
    
    // Extract participant number
    const participantNumber = p.id.split('@')[0].split(':')[0];
    
    console.log(`[DEBUG] Checking admin participant: ${p.id} (${p.admin}) - number: ${participantNumber}`);
    
    // Multiple ways to match:
    // 1. Exact JID match
    if (p.id === botJid) {
      console.log(`[DEBUG] ✅ Matched via exact JID: ${p.id} === ${botJid}`);
      return true;
    }
    
    // 2. Exact LID match
    if (botLid && p.id === botLid) {
      console.log(`[DEBUG] ✅ Matched via exact LID: ${p.id} === ${botLid}`);
      return true;
    }
    
    // 3. Number match from JID
    if (botNumber === participantNumber) {
      console.log(`[DEBUG] ✅ Matched via number from JID: ${botNumber} === ${participantNumber}`);
      return true;
    }
    
    // 4. Number match from LID
    if (botLidNumber && botLidNumber === participantNumber) {
      console.log(`[DEBUG] ✅ Matched via number from LID: ${botLidNumber} === ${participantNumber}`);
      return true;
    }
    
    console.log(`[DEBUG] ❌ No match for ${p.id}`);
    return false;
  });
  
  console.log(`[DEBUG] Final admin check result: ${isAdmin}`);
  return isAdmin;
}

// Send blast message to a phone number - BLAST FUNCTION (Updated for multi-session)
async function sendBlastMessage(userId, phoneNumber, message, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Sending blast message to ${phoneNumber}`);
    
    // Prepare recipient JID
    const recipientJid = `${phoneNumber}@s.whatsapp.net`;
    
    // Send message with timeout
    const sendPromise = sock.sendMessage(recipientJid, { text: message });
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Send message timeout')), 15000)
    );
    
    const result = await Promise.race([sendPromise, timeoutPromise]);
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Successfully sent blast message to ${phoneNumber}`);
    
    return result;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error sending blast message to ${phoneNumber}:`, err);
    throw err;
  }
}

// Get all groups from WhatsApp (Updated for multi-session)
async function getAllGroups(userId, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Getting all groups...`);
    
    // Get all groups
    const groups = await sock.groupFetchAllParticipating();
    const groupList = [];
    
    for (const groupId in groups) {
      const group = groups[groupId];
      
      // Only include groups where bot is participant
      if (group.participants && group.participants.length > 0) {
        const botJid = sock.user.id;
        const botLid = sock.user.lid;
        
        groupList.push({
          id: groupId,
          name: group.subject || 'Unnamed Group',
          participantCount: group.participants.length,
          isAdmin: isBotAdminInGroup(group, botJid, botLid)
        });
      }
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Found ${groupList.length} groups`);
    
    // Sort by name
    groupList.sort((a, b) => a.name.localeCompare(b.name));
    
    return groupList;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error getting groups:`, err);
    throw err;
  }
}

// Get group admins (Updated for multi-session)
async function getGroupAdmins(userId, groupId, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Getting admins for group ${groupId}`);
    
    // Get group metadata
    const groupMetadata = await sock.groupMetadata(groupId);
    
    if (!groupMetadata || !groupMetadata.participants) {
      throw new Error('Gagal mendapatkan data grup');
    }
    
    // Filter only admins
    const admins = groupMetadata.participants.filter(p => 
      p.admin === 'admin' || p.admin === 'superadmin'
    );
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Found ${admins.length} admins in group ${groupId}`);
    
    return admins;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error getting group admins:`, err);
    throw err;
  }
}

// Check if participant is in group (Updated for multi-session)
async function isParticipantInGroup(userId, groupId, participantNumber, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Checking if ${participantNumber} is in group ${groupId}`);
    
    // Get group metadata
    const groupMetadata = await sock.groupMetadata(groupId);
    
    if (!groupMetadata || !groupMetadata.participants) {
      throw new Error('Gagal mendapatkan data grup');
    }
    
    // Check if participant exists
    const participantJid = `${participantNumber}@s.whatsapp.net`;
    const participantLid = `${participantNumber}@lid`;
    
    const isInGroup = groupMetadata.participants.some(p => {
      const participantNumberFromJid = p.id.split('@')[0].split(':')[0];
      return p.id === participantJid || 
             p.id === participantLid || 
             participantNumberFromJid === participantNumber;
    });
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Participant ${participantNumber} in group: ${isInGroup}`);
    
    return isInGroup;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error checking participant in group:`, err);
    return false; // Return false on error to be safe
  }
}

// Add participant to group - UPDATED WITH FLEXIBLE LOGIC (Updated for multi-session)
async function addParticipantToGroup(userId, groupId, participantNumber, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Adding ${participantNumber} to group ${groupId}`);
    
    // Prepare participant JID
    const participantJid = `${participantNumber}@s.whatsapp.net`;
    
    // Get group metadata to check admin status
    const groupMetadata = await sock.groupMetadata(groupId);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    
    // Check if bot is admin using improved logic
    const isAdmin = isBotAdminInGroup(groupMetadata, botJid, botLid);
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Group memberAddMode: ${groupMetadata.memberAddMode}`);
    console.log(`[DEBUG][${userId}][${targetSlot}] Bot admin status: ${isAdmin}`);
    
    if (!isAdmin) {
      // Check if group allows members to add others
      const canMembersAdd = groupMetadata.memberAddMode === true; // explicitly check for true
      
      if (!canMembersAdd) {
        throw new Error('Bot bukan admin dan grup tidak mengizinkan member menambah participant');
      } else {
        console.log(`[DEBUG][${userId}][${targetSlot}] Bot bukan admin tapi grup mengizinkan member menambah participant`);
      }
    } else {
      console.log(`[DEBUG][${userId}][${targetSlot}] Bot adalah admin, dapat menambah participant`);
    }
    
    // Add participant with timeout
    const addPromise = sock.groupParticipantsUpdate(
      groupId,
      [participantJid],
      'add'
    );
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Add participant timeout')), 15000)
    );
    
    const result = await Promise.race([addPromise, timeoutPromise]);
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Add participant result:`, result);
    
    // Check result
    if (result && result.length > 0) {
      const participantResult = result[0];
      if (participantResult.status === '200') {
        console.log(`[DEBUG][${userId}][${targetSlot}] Successfully added ${participantNumber} to group ${groupId}`);
        return true;
      } else {
        const errorCode = participantResult.status || 'unknown';
        const errorMessage = getAddParticipantErrorMessage(errorCode);
        throw new Error(`Gagal add participant: ${errorMessage} (${errorCode})`);
      }
    }
    
    return true;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error adding participant ${participantNumber} to group ${groupId}:`, err);
    throw err;
  }
}

// Get error message for add participant status codes
function getAddParticipantErrorMessage(statusCode) {
  const errorMessages = {
    '403': 'Nomor tidak bisa ditambahkan ke grup (mungkin privasi atau blokir)',
    '408': 'Timeout - nomor tidak merespons',
    '409': 'Participant sudah ada di grup',
    '400': 'Request tidak valid',
    '401': 'Bot tidak memiliki izin',
    '404': 'Nomor tidak ditemukan'
  };
  
  return errorMessages[statusCode] || 'Error tidak dikenal';
}

// Promote participant to admin - UPDATED (Updated for multi-session)
async function promoteParticipant(userId, groupId, participantNumber, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Promoting ${participantNumber} to admin in group ${groupId}`);
    
    // Get group metadata
    const groupMetadata = await sock.groupMetadata(groupId);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    
    // Check if bot is admin using improved logic
    const isAdmin = isBotAdminInGroup(groupMetadata, botJid, botLid);
    
    if (!isAdmin) {
      throw new Error('Bot bukan admin di grup ini');
    }
    
    // Find participant in group with flexible matching
    const participant = groupMetadata.participants.find(p => {
      const participantNumberFromJid = p.id.split('@')[0].split(':')[0];
      return participantNumberFromJid === participantNumber;
    });
    
    if (!participant) {
      throw new Error('Participant tidak ada di grup');
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Found participant: ${participant.id} for number ${participantNumber}`);
    
    // Use the actual JID from group metadata for promote
    const actualJid = participant.id;
    
    // Promote participant with timeout
    const promotePromise = sock.groupParticipantsUpdate(
      groupId,
      [actualJid],
      'promote'
    );
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Promote timeout')), 15000)
    );
    
    const result = await Promise.race([promotePromise, timeoutPromise]);
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Promote result:`, result);
    
    // Check result
    if (result && result.length > 0) {
      const participantResult = result[0];
      if (participantResult.status === '200') {
        console.log(`[DEBUG][${userId}][${targetSlot}] Successfully promoted ${participantNumber} in group ${groupId}`);
        return true;
      } else {
        const errorCode = participantResult.status || 'unknown';
        throw new Error(`Gagal promote: ${errorCode}`);
      }
    }
    
    return true;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error promoting participant ${participantNumber} in group ${groupId}:`, err);
    throw err;
  }
}

// Demote participant from admin - UPDATED (Updated for multi-session)
async function demoteParticipant(userId, groupId, participantNumber, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Demoting ${participantNumber} from admin in group ${groupId}`);
    
    // Prepare participant JID
    const participantJid = `${participantNumber}@s.whatsapp.net`;
    
    // Get group metadata
    const groupMetadata = await sock.groupMetadata(groupId);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    
    // Check if bot is admin using improved logic
    const isAdmin = isBotAdminInGroup(groupMetadata, botJid, botLid);
    
    if (!isAdmin) {
      throw new Error('Bot bukan admin di grup ini');
    }
    
    // Check if participant is admin
    const targetParticipant = groupMetadata.participants.find(p => {
      const participantNumberFromJid = p.id.split('@')[0].split(':')[0];
      return (p.id === participantJid || 
              p.id === `${participantNumber}@lid` ||
              participantNumberFromJid === participantNumber) &&
             (p.admin === 'admin' || p.admin === 'superadmin');
    });
    
    if (!targetParticipant) {
      throw new Error('Participant bukan admin atau tidak ada di grup');
    }
    
    // Demote participant with timeout
    const demotePromise = sock.groupParticipantsUpdate(
      groupId,
      [participantJid],
      'demote'
    );
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Demote timeout')), 15000)
    );
    
    const result = await Promise.race([demotePromise, timeoutPromise]);
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Demote result:`, result);
    
    // Check result
    if (result && result.length > 0) {
      const participantResult = result[0];
      if (participantResult.status === '200') {
        console.log(`[DEBUG][${userId}][${targetSlot}] Successfully demoted ${participantNumber} in group ${groupId}`);
        return true;
      } else {
        const errorCode = participantResult.status || 'unknown';
        throw new Error(`Gagal demote: ${errorCode}`);
      }
    }
    
    return true;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error demoting participant ${participantNumber} in group ${groupId}:`, err);
    throw err;
  }
}

// Rename a group - UPDATED (Updated for multi-session)
async function renameGroup(userId, groupId, newName, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Get session (either specified slot or active slot)
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    const sock = userStates[userId]?.sessions?.[targetSlot]?.socket;
    
    if (!sock || !userStates[userId]?.sessions?.[targetSlot]?.isConnected) {
      throw new Error(`WhatsApp ${targetSlot} tidak terhubung`);
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Renaming group ${groupId} to "${newName}"`);
    
    // Check connection status dulu
    if (!sock.user || !sock.user.id) {
      throw new Error('Socket user tidak tersedia');
    }
    
    // Check if bot is admin in this group
    const groups = await sock.groupFetchAllParticipating();
    const group = groups[groupId];
    
    if (!group) {
      throw new Error('Grup tidak ditemukan');
    }
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Group found: ${group.subject}, participants: ${group.participants.length}`);
    
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Bot JID: ${botJid}, Bot LID: ${botLid}`);
    
    // Use improved admin check
    const isAdmin = isBotAdminInGroup(group, botJid, botLid);
    
    if (!isAdmin) {
      throw new Error('Bot bukan admin di grup ini');
    }
    
    // Rename the group dengan timeout
    console.log(`[DEBUG][${userId}][${targetSlot}] Attempting to rename group...`);
    
    const renamePromise = sock.groupUpdateSubject(groupId, newName);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Rename timeout')), 15000) // 15 detik timeout
    );
    
    await Promise.race([renamePromise, timeoutPromise]);
    
    console.log(`[DEBUG][${userId}][${targetSlot}] Successfully renamed group ${groupId} to "${newName}"`);
    
    return true;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error renaming group ${groupId}:`, err);
    console.error(`[ERROR][${userId}] Full error:`, JSON.stringify(err, null, 2));
    throw err;
  }
}

// Check and approve pending join requests - Alternative approach (Updated for multi-session)
async function checkPendingRequests(userId, sock, slotId) {
  const userStates = getUserStates();
  
  // Only process if auto accept is enabled for this slot
  const sessionData = userStates[userId]?.sessions?.[slotId];
  if (!sessionData?.autoAccept?.enabled) {
    console.log(`[DEBUG][${userId}][${slotId}] Auto accept disabled, skipping pending requests check`);
    return;
  }
  
  try {
    console.log(`[DEBUG][${userId}][${slotId}] Checking for pending join requests...`);
    
    // Get all groups where this bot is admin
    const groups = await sock.groupFetchAllParticipating();
    
    for (const groupId in groups) {
      const group = groups[groupId];
      
      // Check if bot is admin in this group using improved logic
      const botJid = sock.user.id;
      const botLid = sock.user.lid;
      
      const isAdmin = isBotAdminInGroup(group, botJid, botLid);
      
      console.log(`[DEBUG][${userId}][${slotId}] Is admin in group ${groupId}: ${isAdmin}`);
      
      if (!isAdmin) {
        console.log(`[DEBUG][${userId}][${slotId}] Not admin in group ${groupId}, skipping`);
        continue;
      }
      
      console.log(`[DEBUG][${userId}][${slotId}] Checking group ${groupId} for pending requests...`);
      
      try {
        // Try multiple methods to get pending requests
        let pendingRequests = [];
        
        // Method 1: Try groupRequestParticipantsList
        try {
          const requests1 = await sock.groupRequestParticipantsList(groupId);
          if (requests1 && requests1.length > 0) {
            pendingRequests = requests1;
            console.log(`[DEBUG][${userId}][${slotId}] Method 1: Found ${requests1.length} pending requests`);
          }
        } catch (err) {
          console.log(`[DEBUG][${userId}][${slotId}] Method 1 failed: ${err.message}`);
        }
        
        // Method 2: Try groupGetInviteInfo if method 1 fails
        if (pendingRequests.length === 0) {
          try {
            const groupInfo = await sock.groupMetadata(groupId);
            console.log(`[DEBUG][${userId}][${slotId}] Group metadata:`, JSON.stringify(groupInfo, null, 2));
            
            // Check if there are pending requests in metadata
            if (groupInfo.pendingParticipants && groupInfo.pendingParticipants.length > 0) {
              pendingRequests = groupInfo.pendingParticipants;
              console.log(`[DEBUG][${userId}][${slotId}] Method 2: Found ${pendingRequests.length} pending requests in metadata`);
            }
          } catch (err) {
            console.log(`[DEBUG][${userId}][${slotId}] Method 2 failed: ${err.message}`);
          }
        }
        
        // Process pending requests if found
        if (pendingRequests && pendingRequests.length > 0) {
          console.log(`[DEBUG][${userId}][${slotId}] Processing ${pendingRequests.length} pending requests in group ${groupId}`);
          
          // Approve all pending requests
          for (const request of pendingRequests) {
            try {
              const participantJid = request.jid || request.id || request;
              console.log(`[DEBUG][${userId}][${slotId}] Attempting to approve: ${participantJid}`);
              
              await sock.groupRequestParticipantsUpdate(
                groupId,
                [participantJid],
                'approve'
              );
              console.log(`[DEBUG][${userId}][${slotId}] ✅ Auto approved pending request from ${participantJid} in group ${groupId}`);
              
              // Small delay to avoid rate limits
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
              console.error(`[ERROR][${userId}][${slotId}] Failed to approve ${request.jid || request.id || request}:`, err.message);
            }
          }
        } else {
          console.log(`[DEBUG][${userId}][${slotId}] No pending requests found for group ${groupId}`);
        }
      } catch (err) {
        console.log(`[DEBUG][${userId}][${slotId}] Could not check pending requests for group ${groupId}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[ERROR][${userId}][${slotId}] Error checking pending requests:`, err.message);
  }
}

// Restore all existing sessions on startup (Updated for multi-session)
async function restoreAllSessions(bot) {
  const sessionsPath = config.whatsapp.sessionPath;
  const restoredSessions = [];
  
  if (!fs.existsSync(sessionsPath)) {
    console.log('No sessions directory found');
    return restoredSessions;
  }
  
  try {
    const sessionDirs = fs.readdirSync(sessionsPath)
      .filter(dir => dir.startsWith('wa_') && fs.statSync(path.join(sessionsPath, dir)).isDirectory());
    
    console.log(`Found ${sessionDirs.length} potential sessions:`, sessionDirs);
    
    for (const sessionDir of sessionDirs) {
      try {
        // Extract userId and slotId from folder name (wa_userId_slotId -> userId, slotId)
        const parts = sessionDir.replace('wa_', '').split('_');
        if (parts.length < 2) {
          console.log(`Skipping ${sessionDir} - invalid format (expected: wa_userId_slotId)`);
          continue;
        }
        
        const userId = parts[0];
        const slotId = parts.slice(1).join('_'); // Handle slot IDs with underscores
        
        // Check if session has required files
        const sessionPath = path.join(sessionsPath, sessionDir);
        const credsFile = path.join(sessionPath, 'creds.json');
        
        if (!fs.existsSync(credsFile)) {
          console.log(`Skipping ${sessionDir} - no creds.json found`);
          continue;
        }
        
        // Check if user has premium access
        const premiumInfo = await UserFileManager.getPremiumInfo(userId);
        if (!premiumInfo.isPremium) {
          console.log(`Skipping ${sessionDir} - user ${userId} doesn't have premium access`);
          continue;
        }
        
        console.log(`Restoring session for userId: ${userId}, slotId: ${slotId}`);
        
        // Create connection for this user and slot
        const sock = await createWhatsAppConnection(userId, bot, slotId, false, true);
        
        if (sock) {
          restoredSessions.push(`${userId}/${slotId}`);
          console.log(`✅ Session restored for userId: ${userId}, slotId: ${slotId}`);
          
          // Wait a bit between connections to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.log(`❌ Failed to restore session for userId: ${userId}, slotId: ${slotId}`);
        }
      } catch (err) {
        console.error(`Error restoring session ${sessionDir}:`, err.message);
      }
    }
    
    return restoredSessions;
  } catch (err) {
    console.error('Error scanning sessions directory:', err);
    return restoredSessions;
  }
}

// Create WhatsApp connection (Updated for multi-session)
async function createWhatsAppConnection(userId, bot, slotId = 'slot_1', reconnect = false, isRestore = false) {
  try {
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}_${slotId}`);
    
    // Pastikan folder session ada (JANGAN HAPUS SESSION LAMA)
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // Check if this is a fresh session or existing one
    const isExistingSession = fs.existsSync(path.join(sessionPath, 'creds.json'));
    
    // Buat socket dengan browser config lengkap
    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Safari"),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 5000
    });
    
    // Log all events for debugging (compatible version)
    sock.ev.process(
      async (events) => {
        for (const key in events) {
          if (events[key]) {
            console.log(`[DEBUG][${userId}][${slotId}][process] Event:`, key, JSON.stringify(events[key], null, 2));
          }
        }
      }
    );
    
    // Save user state
    const userStates = getUserStates();
    
    if (!userStates[userId]) {
      userStates[userId] = {};
    }
    
    if (!userStates[userId].sessions) {
      userStates[userId].sessions = {};
    }
    
    userStates[userId].sessions[slotId] = {
      socket: sock,
      isConnected: false,
      lastConnect: null,
      isWaitingForPairingCode: false,
      isWaitingForQR: false,
      lastQRTime: null,
      isExistingSession: isExistingSession,
      autoAccept: { enabled: false }
    };
    
    // Load auto accept settings from file
    try {
      const userData = await UserFileManager.loadUser(userId);
      if (userData.sessions?.[slotId]?.autoAccept) {
        userStates[userId].sessions[slotId].autoAccept = userData.sessions[slotId].autoAccept;
      }
    } catch (err) {
      console.warn(`Could not load auto accept settings for ${userId}/${slotId}:`, err.message);
    }
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    // Handle connection update
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log(`[DEBUG] Connection update for ${userId}/${slotId}: ${connection}`);
      
      // Handle QR code if available (only for new sessions)
      if (qr && !isExistingSession && userStates[userId]?.sessions?.[slotId]?.isWaitingForQR) {
        const now = Date.now();
        const lastQRTime = userStates[userId].sessions[slotId].lastQRTime || 0;
        
        if (now - lastQRTime < 30000) {
          console.log(`[DEBUG] Skipping QR code for ${userId}/${slotId} - too soon since last QR`);
          return;
        }
        
        try {
          userStates[userId].sessions[slotId].lastQRTime = now;
          
          const qrUrl = await require('qrcode').toDataURL(qr);
          const qrBuffer = Buffer.from(qrUrl.split(',')[1], 'base64');
          
          await bot.sendPhoto(userId, qrBuffer, {
            caption: `🔒 *Scan QR Code untuk ${slotId.toUpperCase()}*\n\nBuka WhatsApp > Menu > Perangkat Tertaut > Tautkan Perangkat\n\nQR code valid selama 60 detik!`,
            parse_mode: 'Markdown'
          });
          
          console.log(`[DEBUG] Sent QR code to user ${userId} for slot ${slotId}`);
        } catch (qrErr) {
          console.error(`[ERROR] Failed to send QR code: ${qrErr.message}`);
          await bot.sendMessage(userId, "❌ Error saat mengirim QR code. Coba lagi nanti.");
        }
      }
      
      if (connection === "open") {
        console.log(`WhatsApp connection open for user: ${userId}/${slotId}`);
        
        // Reset reconnect attempts
        const reconnectKey = `${userId}_${slotId}`;
        reconnectAttempts[reconnectKey] = 0;
        
        // Setup auto accept handler for this specific slot
        setupAutoAcceptHandler(userId, slotId);
        
        // Update state
        if (userStates[userId] && userStates[userId].sessions?.[slotId]) {
          userStates[userId].sessions[slotId].isConnected = true;
          userStates[userId].sessions[slotId].lastConnect = new Date();
          userStates[userId].sessions[slotId].isWaitingForPairingCode = false;
          userStates[userId].sessions[slotId].isWaitingForQR = false;
          userStates[userId].sessions[slotId].lastQRTime = null;
          
          // Update session name from WhatsApp profile
          const sessionName = sock.user?.verifiedName || sock.user?.name || `Slot ${slotId.replace('slot_', '')}`;
          userStates[userId].sessions[slotId].sessionName = sessionName;
          
          // Save to file
          await UserFileManager.updateSessionInfo(userId, slotId, {
            isActive: true,
            sessionName: sessionName,
            lastConnect: new Date().toISOString()
          });
        }
        
        // Check and approve pending requests after connection is stable
        setTimeout(async () => {
          await checkPendingRequests(userId, sock, slotId);
        }, 5000); // Wait 5 seconds for connection to stabilize
        
        // Send success message
        if (isRestore) {
          console.log(`Session restored for userId: ${userId}/${slotId}`);
        } else if (reconnect) {
          await bot.sendMessage(
            userId,
            `✅ *Reconnect berhasil untuk ${slotId.toUpperCase()}!* Bot WhatsApp sudah terhubung kembali.`,
            { parse_mode: 'Markdown' }
          );
        } else if (!isRestore) {
          await bot.sendMessage(
            userId,
            `🚀 *Bot WhatsApp ${slotId.toUpperCase()} berhasil terhubung!*\n\nSekarang kamu bisa menggunakan auto accept untuk slot ini!`,
            { parse_mode: 'Markdown' }
          );
        }
      } else if (connection === "close") {
        // Update state
        if (userStates[userId] && userStates[userId].sessions?.[slotId]) {
          userStates[userId].sessions[slotId].isConnected = false;
        }
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = lastDisconnect?.error?.output?.payload?.message || "Unknown";
        
        console.log(`[DEBUG] Connection closed for userId ${userId}/${slotId}. Status code: ${statusCode}, Reason: ${disconnectReason}`);
        
        // Cek apakah perlu reconnect
        let shouldReconnect = true;
        
        // Status code 401 atau 403 biasanya logout/banned
        if (statusCode === 401 || statusCode === 403) {
          shouldReconnect = false;
        }
        
        // Tambah tracking reconnect attempts per slot
        const reconnectKey = `${userId}_${slotId}`;
        if (!reconnectAttempts[reconnectKey]) {
          reconnectAttempts[reconnectKey] = 0;
        }
        
        // Logika reconnect
        if (shouldReconnect && userStates[userId] && reconnectAttempts[reconnectKey] < MAX_RECONNECT_ATTEMPTS) {
          // Increment attempt counter
          reconnectAttempts[reconnectKey]++;
          
          // Notify user on first attempt only (skip for restore)
          if (reconnectAttempts[reconnectKey] === 1 && !isRestore) {
            await bot.sendMessage(
              userId, 
              `⚠️ *Koneksi ${slotId.toUpperCase()} terputus*\nReason: ${disconnectReason}\n\nSedang mencoba reconnect... (Attempt ${reconnectAttempts[reconnectKey]}/${MAX_RECONNECT_ATTEMPTS})`,
              { parse_mode: 'Markdown' }
            );
          }
          
          // Wait before reconnect
          setTimeout(async () => {
            if (userStates[userId]) {
              console.log(`[DEBUG] Attempting to reconnect for userId: ${userId}/${slotId} (Attempt ${reconnectAttempts[reconnectKey]}/${MAX_RECONNECT_ATTEMPTS})`);
              await createWhatsAppConnection(userId, bot, slotId, true);
            }
          }, config.whatsapp.reconnectDelay || 5000);
        } else if (userStates[userId]) {
          // Reset attempts
          reconnectAttempts[reconnectKey] = 0;
          
          // Send permanent disconnect message (skip for restore)
          if (!isRestore) {
            await bot.sendMessage(
              userId, 
              `❌ *Koneksi ${slotId.toUpperCase()} terputus permanen*\nPerlu login ulang pakai pairing code lagi.`, 
              { parse_mode: 'Markdown' }
            );
          }
          
          // Delete session files only if logout/banned
          if (statusCode === 401 || statusCode === 403) {
            const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}_${slotId}`);
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
              console.log(`Session files deleted for userId: ${userId}/${slotId}`);
            }
          }
          
          // Clear user state for this slot
          if (userStates[userId].sessions?.[slotId]) {
            userStates[userId].sessions[slotId] = {
              socket: null,
              isConnected: false,
              lastConnect: null,
              isWaitingForPairingCode: false,
              isWaitingForQR: false,
              lastQRTime: null,
              autoAccept: { enabled: false }
            };
          }
          
          // Update file state
          await UserFileManager.updateSessionInfo(userId, slotId, {
            isActive: false,
            lastConnect: new Date().toISOString()
          });
        }
      }
    });
    
    // Handle join requests - Multiple event handlers for this specific slot
    sock.ev.on('group.join-request', async (update) => {
      console.log(`[DEBUG][${userId}][${slotId}] group.join-request event:`, JSON.stringify(update, null, 2));
      
      if (!userStates[userId].sessions?.[slotId]?.autoAccept?.enabled) {
        console.log(`[DEBUG][${userId}][${slotId}] Auto accept disabled for group.join-request`);
        return;
      }

      const { id, participant, author } = update;
      
      try {
        console.log(`[DEBUG][${userId}][${slotId}] Attempting to approve ${participant || author} for group ${id} via group.join-request`);
        
        const targetParticipant = participant || author;
        
        await sock.groupRequestParticipantsUpdate(
          id, // group id
          [targetParticipant], // participant to approve
          'approve' // approve | reject
        );
        console.log(`[DEBUG][${userId}][${slotId}] ✅ Auto approved ${targetParticipant} for group ${id} via group.join-request`);
      } catch (err) {
        console.error(`[ERROR][${userId}][${slotId}] Error auto accepting (group.join-request):`, err.message);
      }
    });
    
    // Additional handler for messages.upsert with GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST
    sock.ev.on('messages.upsert', async (messageUpdate) => {
      if (!userStates[userId].sessions?.[slotId]?.autoAccept?.enabled) return;
      
      const { messages } = messageUpdate;
      
      for (const message of messages) {
        // Check if this is a join approval request message
        if (message.messageStubType === 'GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD') {
          console.log(`[DEBUG][${userId}][${slotId}] Found join approval request in messages.upsert:`, JSON.stringify(message, null, 2));
          
          const groupId = message.key.remoteJid;
          const participant = message.participant;
          const stubParams = message.messageStubParameters || [];
          
          try {
            console.log(`[DEBUG][${userId}][${slotId}] Attempting to approve ${participant} for group ${groupId} via messages.upsert`);
            
            await sock.groupRequestParticipantsUpdate(
              groupId,
              [participant],
              'approve'
            );
            console.log(`[DEBUG][${userId}][${slotId}] ✅ Auto approved ${participant} for group ${groupId} via messages.upsert`);
          } catch (err) {
            console.error(`[ERROR][${userId}][${slotId}] Error auto accepting via messages.upsert:`, err.message);
          }
        }
      }
    });
    
    return sock;
  } catch (err) {
    console.error(`Error creating WhatsApp connection for ${userId}/${slotId}:`, err);
    
    if (!reconnect && !isRestore) {
      await bot.sendMessage(
        userId,
        `❌ Ada error saat membuat koneksi ${slotId}: ${err.message}`
      );
    }
    
    return null;
  }
}

// Generate pairing code (Updated for multi-session)
async function generatePairingCode(userId, phoneNumber, bot, messageId, slotId = 'slot_1') {
  const userStates = getUserStates();
  
  try {
    // Check if socket exists for this slot
    if (!userStates[userId]?.sessions?.[slotId]?.socket) {
      throw new Error("Koneksi WhatsApp belum dibuat");
    }
    
    const sock = userStates[userId].sessions[slotId].socket;
    
    // Set flag to indicate we're in pairing phase
    userStates[userId].sessions[slotId].isWaitingForPairingCode = true;
    
    // Store phone number
    userStates[userId].sessions[slotId].phoneNumber = phoneNumber;
    
    // Delete loading message
    try {
      await bot.deleteMessage(userId, messageId);
    } catch (err) {
      console.warn(`Could not delete loading message: ${err.message}`);
    }
    
    // Request pairing code with options
    const code = await sock.requestPairingCode(phoneNumber);
    
    // Send pairing code
    await bot.sendMessage(
      userId,
      `🔑 *Pairing Code untuk ${slotId.toUpperCase()}:*\n\n*${code}*\n\nMasukkan code di atas ke WhatsApp kamu dalam 60 detik!\n\nBuka WhatsApp > Menu > Perangkat Tertaut > Tautkan Perangkat\n\nKalau terputus, otomatis akan reconnect!`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'session_manager' }]
          ]
        }
      }
    );
    
    return true;
  } catch (err) {
    console.error(`Error generating pairing code for ${userId}/${slotId}:`, err);
    
    // Delete loading message if exists
    try {
      await bot.deleteMessage(userId, messageId);
    } catch (delErr) {
      console.warn(`Could not delete loading message: ${delErr.message}`);
    }
    
    // Send error message
    await bot.sendMessage(
      userId,
      `❌ Gagal membuat pairing code untuk ${slotId}. Coba lagi nanti atau pakai nomor lain`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📱 Session Manager', callback_data: 'session_manager' }]
          ]
        }
      }
    );
    
    return false;
  }
}

// Setup auto accept handler for specific slot
function setupAutoAcceptHandler(userId, slotId) {
  const userStates = getUserStates();
  const sock = userStates[userId]?.sessions?.[slotId]?.socket;
  
  if (!sock || userStates[userId].sessions[slotId].autoAcceptHandlerActive) return;
  
  // Handle join requests for this specific slot
  sock.ev.on('group-participants.update', async (update) => {
    console.log(`[DEBUG][${userId}][${slotId}] Group participants update:`, update);
    
    // Check if auto accept is enabled for this slot
    if (!userStates[userId].sessions[slotId].autoAccept?.enabled) {
      console.log(`[DEBUG][${userId}][${slotId}] Auto accept is disabled, skipping`);
      return;
    }
    
    const { id, participants, action } = update;
    console.log(`[DEBUG][${userId}][${slotId}] Action: ${action}, Group: ${id}, Participants: ${participants.join(', ')}`);
    
    // Only process join_request action
    if (action !== 'join_request') {
      console.log(`[DEBUG][${userId}][${slotId}] Not a join request, skipping`);
      return;
    }
    
    try {
      // Approve all join requests
      for (const jid of participants) {
        console.log(`[DEBUG][${userId}][${slotId}] Attempting to approve ${jid} for group ${id}`);
        await sock.groupRequestParticipantsUpdate(
          id, // group id
          [jid], // participants to approve
          'approve' // approve | reject
        );
        
        console.log(`[DEBUG][${userId}][${slotId}] Successfully approved ${jid} for group ${id}`);
      }
    } catch (err) {
      console.error(`[ERROR][${userId}][${slotId}] Error auto accepting:`, err);
    }
  });
  
  userStates[userId].sessions[slotId].autoAcceptHandlerActive = true;
}

// Toggle auto accept for specific slot
async function toggleAutoAccept(userId, enabled, slotId = null) {
  const userStates = getUserStates();
  
  // Determine target slot
  const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
  
  if (!userStates[userId]) {
    userStates[userId] = {};
  }
  
  if (!userStates[userId].sessions) {
    userStates[userId].sessions = {};
  }
  
  if (!userStates[userId].sessions[targetSlot]) {
    userStates[userId].sessions[targetSlot] = {};
  }
  
  if (!userStates[userId].sessions[targetSlot].autoAccept) {
    userStates[userId].sessions[targetSlot].autoAccept = {};
  }
  
  userStates[userId].sessions[targetSlot].autoAccept.enabled = enabled;
  
  // Save to file
  await UserFileManager.updateSessionInfo(userId, targetSlot, {
    autoAccept: { enabled }
  });
  
  // Re-setup handler if enabling
  if (enabled && userStates[userId].sessions[targetSlot].isConnected) {
    setupAutoAcceptHandler(userId, targetSlot);
  }
  
  // Check pending requests if enabling auto accept
  if (enabled && userStates[userId].sessions[targetSlot].isConnected) {
    const sock = userStates[userId].sessions[targetSlot].socket;
    if (sock) {
      setTimeout(async () => {
        await checkPendingRequests(userId, sock, targetSlot);
      }, 1000);
    }
  }
  
  return { success: true, enabled, slotId: targetSlot };
}

// Get auto accept status for specific slot
function getAutoAcceptStatus(userId, slotId = null) {
  const userStates = getUserStates();
  
  // Determine target slot
  const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
  
  return {
    enabled: userStates[userId]?.sessions?.[targetSlot]?.autoAccept?.enabled || false,
    slotId: targetSlot
  };
}

// Logout WhatsApp for specific slot
async function logoutWhatsApp(userId, slotId = null) {
  const userStates = getUserStates();
  
  try {
    // Determine target slot
    const targetSlot = slotId || userStates[userId]?.activeSlot || 'slot_1';
    
    // Logout if connected
    if (userStates[userId]?.sessions?.[targetSlot]?.socket) {
      await userStates[userId].sessions[targetSlot].socket.logout();
    }
    
    // Delete session files for this specific slot
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}_${targetSlot}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    // Clear state for this slot only
    if (userStates[userId]?.sessions?.[targetSlot]) {
      delete userStates[userId].sessions[targetSlot];
    }
    
    // Update file state
    await UserFileManager.updateSessionInfo(userId, targetSlot, {
      isActive: false,
      sessionName: null,
      lastConnect: null
    });
    
    // Reset reconnect attempts for this slot
    const reconnectKey = `${userId}_${targetSlot}`;
    reconnectAttempts[reconnectKey] = 0;
    
    console.log(`✅ Successfully logged out ${userId}/${targetSlot}`);
    return true;
  } catch (err) {
    console.error(`Error logging out ${userId}/${slotId}:`, err);
    return false;
  }
}

module.exports = {
  createWhatsAppConnection,
  generatePairingCode,
  toggleAutoAccept,
  getAutoAcceptStatus,
  logoutWhatsApp,
  restoreAllSessions,
  checkPendingRequests,
  getAllGroups,
  renameGroup,
  addParticipantToGroup,
  promoteParticipant,
  demoteParticipant,
  getGroupAdmins,
  isParticipantInGroup,
  sendBlastMessage
};