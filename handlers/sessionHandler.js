const { 
  createWhatsAppConnection, 
  generatePairingCode, 
  logoutWhatsApp,
  toggleAutoAccept,
  getAutoAcceptStatus
} = require('../whatsappClient');
const { showMainMenu, showSessionManager } = require('./menuHandler');
const UserFileManager = require('../utils/userFileManager');
const { 
  safeDeleteMessage, 
  safeEditMessage, 
  isValidPhoneNumber, 
  cleanPhoneNumber,
  formatDate,
  clearUserFlowState
} = require('../utils/helpers');

// Handle session-related callbacks
async function handleSessionCallbacks(query, bot, userStates) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  
  try {
    switch(true) {
      case data === 'session_manager':
        await showSessionManager(chatId, bot, query.message.message_id);
        break;
        
      case data.startsWith('switch_slot_'):
        const slotId = data.replace('switch_slot_', '');
        await handleSwitchSlot(chatId, userId, slotId, bot, userStates, query.message.message_id);
        break;
        
      case data.startsWith('login_slot_'):
        const loginSlotId = data.replace('login_slot_', '');
        await handleLoginSlot(chatId, userId, loginSlotId, bot, userStates);
        break;
        
      case data.startsWith('logout_slot_'):
        const logoutSlotId = data.replace('logout_slot_', '');
        await handleLogoutSlot(chatId, userId, logoutSlotId, bot, userStates, query.message.message_id);
        break;
        
      case data.startsWith('setup_slot_'):
        const setupSlotId = data.replace('setup_slot_', '');
        await handleSetupSlot(chatId, userId, setupSlotId, bot, userStates);
        break;
        
      case data === 'buy_additional_slot':
        await handleBuyAdditionalSlot(chatId, bot, query.message.message_id);
        break;
        
      case data === 'buy_premium_first':
        await handleBuyPremiumFirst(chatId, bot, query.message.message_id);
        break;
    }
  } catch (err) {
    console.error('Error in session callback handler:', err);
    await bot.sendMessage(chatId, '❌ Terjadi error saat memproses session management.');
  }
}

// Handle session-related messages
async function handleSessionMessages(msg, bot, userStates) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  // Handle phone number input for specific slot
  if (userStates[userId]?.waitingForPhone && userStates[userId]?.targetSlot) {
    userStates[userId].waitingForPhone = false;
    const targetSlot = userStates[userId].targetSlot;
    delete userStates[userId].targetSlot;
    
    // Delete user's message for privacy
    await safeDeleteMessage(bot, chatId, msg.message_id);
    
    // Validate phone number
    const phoneNumber = cleanPhoneNumber(text);
    if (!isValidPhoneNumber(phoneNumber)) {
      await bot.sendMessage(chatId, '❌ Format nomor salah! Harus 10-15 digit angka saja.');
      return true;
    }
    
    const loadingMsg = await bot.sendMessage(chatId, `⏳ Tunggu bentar, lagi bikin koneksi untuk ${targetSlot}...`);
    
    try {
      // Create connection for specific slot
      const sock = await createWhatsAppConnection(userId, bot, targetSlot);
      if (!sock) throw new Error('Gagal bikin koneksi');
      
      // Wait 3 seconds for stable connection
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Generate pairing code
      await generatePairingCode(userId, phoneNumber, bot, loadingMsg.message_id, targetSlot);
    } catch (err) {
      await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: `login_slot_${targetSlot}` }],
            [{ text: '📱 Session Manager', callback_data: 'session_manager' }]
          ]
        }
      });
    }
    return true;
  }
  
  return false; // Not handled
}

// Handle switch active slot
async function handleSwitchSlot(chatId, userId, slotId, bot, userStates, messageId) {
  try {
    // Check premium access
    const premiumInfo = await UserFileManager.getPremiumInfo(userId);
    if (!premiumInfo.isPremium) {
      return await safeEditMessage(bot, chatId, messageId, 
        '❌ Akses premium diperlukan untuk menggunakan fitur ini.', {
          reply_markup: {
            inline_keyboard: [[{ text: '💳 Beli Premium', callback_data: 'buy_premium_first' }]]
          }
        });
    }

    // Check if slot exists
    const userData = await UserFileManager.loadUser(userId);
    if (!userData.sessions[slotId]) {
      return await safeEditMessage(bot, chatId, messageId, 
        '❌ Slot tidak ditemukan.', {
          reply_markup: {
            inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
          }
        });
    }

    // Switch active slot
    const success = await UserFileManager.switchActiveSlot(userId, slotId);
    
    if (success) {
      // Update userStates for current session
      if (!userStates[userId]) userStates[userId] = {};
      if (!userStates[userId].sessions) userStates[userId].sessions = {};
      
      // Set active slot in memory
      userStates[userId].activeSlot = slotId;
      
      await bot.sendMessage(chatId, `✅ Berhasil switch ke ${slotId}!`);
      await showSessionManager(chatId, bot, messageId);
    } else {
      await safeEditMessage(bot, chatId, messageId, 
        '❌ Gagal switch slot.', {
          reply_markup: {
            inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
          }
        });
    }
  } catch (error) {
    console.error('Error switching slot:', error);
    await bot.sendMessage(chatId, '❌ Terjadi error saat switch slot.');
  }
}

// Handle login to specific slot
async function handleLoginSlot(chatId, userId, slotId, bot, userStates) {
  try {
    // Check premium access
    const premiumInfo = await UserFileManager.getPremiumInfo(userId);
    if (!premiumInfo.isPremium) {
      return await bot.sendMessage(chatId, 
        '❌ Akses premium diperlukan untuk menggunakan fitur ini.', {
          reply_markup: {
            inline_keyboard: [[{ text: '💳 Beli Premium', callback_data: 'buy_premium_first' }]]
          }
        });
    }

    // Check if already connected
    if (userStates[userId]?.sessions?.[slotId]?.isConnected) {
      return await bot.sendMessage(chatId, 
        `✅ ${slotId} sudah terhubung! Ga perlu login lagi.`, {
          reply_markup: {
            inline_keyboard: [[{ text: '📱 Session Manager', callback_data: 'session_manager' }]]
          }
        });
    }
    
    // Set waiting state for phone number
    if (!userStates[userId]) userStates[userId] = {};
    userStates[userId].waitingForPhone = true;
    userStates[userId].targetSlot = slotId;
    
    await bot.sendMessage(chatId, 
      `📱 Login ${slotId.toUpperCase()}\n\nKirim nomor WA untuk ${slotId} (dengan kode negara, tanpa +):\n\nContoh: 628123456789`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'session_manager' }]
          ]
        }
      });
  } catch (error) {
    console.error('Error handling login slot:', error);
    await bot.sendMessage(chatId, '❌ Terjadi error saat login slot.');
  }
}

// Handle logout from specific slot
async function handleLogoutSlot(chatId, userId, slotId, bot, userStates, messageId) {
  try {
    const loadingMsg = await bot.sendMessage(chatId, `⏳ Sedang logout ${slotId}...`);
    
    // Logout WhatsApp for specific slot
    const success = await logoutWhatsApp(userId, slotId);
    
    // Update session state in file
    await UserFileManager.updateSessionInfo(userId, slotId, {
      isActive: false,
      sessionName: null,
      lastConnect: null
    });

    // Update memory state
    if (userStates[userId]?.sessions?.[slotId]) {
      delete userStates[userId].sessions[slotId];
    }

    await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    
    if (success) {
      await bot.sendMessage(chatId, `✅ ${slotId} berhasil logout!`);
    } else {
      await bot.sendMessage(chatId, `❌ Error saat logout ${slotId}.`);
    }
    
    // Show updated session manager
    await showSessionManager(chatId, bot);
  } catch (error) {
    console.error('Error handling logout slot:', error);
    await bot.sendMessage(chatId, '❌ Terjadi error saat logout slot.');
  }
}

// Handle setup new slot
async function handleSetupSlot(chatId, userId, slotId, bot, userStates) {
  try {
    // Check premium access
    const premiumInfo = await UserFileManager.getPremiumInfo(userId);
    if (!premiumInfo.isPremium) {
      return await bot.sendMessage(chatId, 
        '❌ Akses premium diperlukan untuk menggunakan fitur ini.', {
          reply_markup: {
            inline_keyboard: [[{ text: '💳 Beli Premium', callback_data: 'buy_premium_first' }]]
          }
        });
    }

    // Create slot if not exists
    const success = await UserFileManager.createSessionSlot(userId, slotId);
    
    if (success) {
      await bot.sendMessage(chatId, 
        `✅ ${slotId} berhasil dibuat!\n\nSekarang Anda bisa login untuk menggunakan slot ini.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: `🔑 Login ${slotId}`, callback_data: `login_slot_${slotId}` }],
              [{ text: '📱 Session Manager', callback_data: 'session_manager' }]
            ]
          }
        });
    } else {
      await bot.sendMessage(chatId, '❌ Gagal membuat slot.');
    }
  } catch (error) {
    console.error('Error setting up slot:', error);
    await bot.sendMessage(chatId, '❌ Terjadi error saat setup slot.');
  }
}

// Handle buy additional slot
async function handleBuyAdditionalSlot(chatId, bot, messageId) {
  try {
    const { showPaymentMenu } = require('./menuHandler');
    await showPaymentMenu(chatId, bot, 'additional_slot', messageId);
  } catch (error) {
    console.error('Error handling buy additional slot:', error);
    await bot.sendMessage(chatId, '❌ Terjadi error saat membuat pembayaran.');
  }
}

// Handle buy premium first slot
async function handleBuyPremiumFirst(chatId, bot, messageId) {
  try {
    const { showPaymentMenu } = require('./menuHandler');
    await showPaymentMenu(chatId, bot, 'first_slot', messageId);
  } catch (error) {
    console.error('Error handling buy premium first:', error);
    await bot.sendMessage(chatId, '❌ Terjadi error saat membuat pembayaran.');
  }
}

// Get active session for user (untuk compatibility dengan kode lama)
function getActiveSession(userId, userStates) {
  try {
    if (!userStates[userId]) return null;
    
    const activeSlot = userStates[userId].activeSlot;
    if (!activeSlot || !userStates[userId].sessions?.[activeSlot]) return null;
    
    return userStates[userId].sessions[activeSlot];
  } catch (error) {
    console.error('Error getting active session:', error);
    return null;
  }
}

// Update session name when WhatsApp connects
async function updateSessionName(userId, slotId, sessionName) {
  try {
    await UserFileManager.updateSessionInfo(userId, slotId, {
      sessionName: sessionName,
      lastConnect: new Date().toISOString(),
      isActive: true
    });
    
    console.log(`✅ Updated session name for ${userId}/${slotId}: ${sessionName}`);
    return true;
  } catch (error) {
    console.error('Error updating session name:', error);
    return false;
  }
}

// Initialize user sessions in memory from file
async function initializeUserSessions(userId, userStates) {
  try {
    const userData = await UserFileManager.loadUser(userId);
    
    if (!userStates[userId]) {
      userStates[userId] = {};
    }
    
    userStates[userId].sessions = {};
    userStates[userId].activeSlot = userData.activeSlot;
    
    // Initialize each session in memory
    for (const [slotId, slotData] of Object.entries(userData.sessions)) {
      userStates[userId].sessions[slotId] = {
        socket: null,
        isConnected: false,
        autoAccept: slotData.autoAccept || { enabled: false },
        sessionName: slotData.sessionName,
        lastConnect: slotData.lastConnect
      };
    }
    
    console.log(`✅ Initialized sessions for user ${userId}`);
    return true;
  } catch (error) {
    console.error('Error initializing user sessions:', error);
    return false;
  }
}

// Get session by slot ID
function getSessionBySlot(userId, slotId, userStates) {
  try {
    if (!userStates[userId]?.sessions?.[slotId]) return null;
    return userStates[userId].sessions[slotId];
  } catch (error) {
    console.error('Error getting session by slot:', error);
    return null;
  }
}

// Check if user has access to features (premium check)
async function checkFeatureAccess(userId, feature = 'basic') {
  try {
    const premiumInfo = await UserFileManager.getPremiumInfo(userId);
    
    switch (feature) {
      case 'basic':
        return premiumInfo.isPremium;
      case 'multi_session':
        return premiumInfo.isPremium && premiumInfo.totalSlots > 1;
      case 'session_manager':
        return premiumInfo.isPremium;
      default:
        return premiumInfo.isPremium;
    }
  } catch (error) {
    console.error('Error checking feature access:', error);
    return false;
  }
}

// Auto-initialize sessions on bot start
async function autoInitializeSessions(userStates, bot) {
  try {
    console.log('🔄 Auto-initializing user sessions...');
    
    // Get all users
    const allUsers = await UserFileManager.getAllUsers();
    let initializedCount = 0;
    
    for (const [userId, userData] of Object.entries(allUsers)) {
      try {
        // Check if user has premium access
        const premiumInfo = await UserFileManager.getPremiumInfo(userId);
        
        if (!premiumInfo.isPremium) {
          console.log(`⏭️ Skipping user ${userId} - no premium access`);
          continue;
        }
        
        // Initialize sessions in memory
        await initializeUserSessions(userId, userStates);
        
        // Try to restore active sessions (yang masih login)
        for (const [slotId, slotData] of Object.entries(userData.sessions)) {
          if (slotData.isActive && slotData.lastConnect) {
            console.log(`🔄 Attempting to restore session ${userId}/${slotId}...`);
            
            try {
              // Attempt to restore connection
              const sock = await createWhatsAppConnection(userId, bot, slotId, false, true);
              
              if (sock) {
                console.log(`✅ Session restored: ${userId}/${slotId}`);
                initializedCount++;
                
                // Small delay to avoid overwhelming
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            } catch (sessionError) {
              console.log(`⚠️ Could not restore session ${userId}/${slotId}: ${sessionError.message}`);
            }
          }
        }
      } catch (userError) {
        console.error(`Error initializing sessions for user ${userId}:`, userError);
      }
    }
    
    console.log(`✅ Auto-initialization complete. ${initializedCount} sessions restored.`);
    return initializedCount;
  } catch (error) {
    console.error('Error in auto-initialize sessions:', error);
    return 0;
  }
}

// Middleware untuk check premium access
function requirePremium(handler) {
  return async (chatId, userId, bot, userStates, ...args) => {
    try {
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      
      if (!hasAccess) {
        await bot.sendMessage(chatId, 
          '🚫 *Premium Required*\n\nFitur ini hanya tersedia untuk pengguna premium.', {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💳 Beli Premium', callback_data: 'buy_premium_first' }],
                [{ text: '« Kembali', callback_data: 'main_menu' }]
              ]
            }
          });
        return;
      }
      
      // Execute original handler
      return await handler(chatId, userId, bot, userStates, ...args);
    } catch (error) {
      console.error('Error in premium middleware:', error);
      await bot.sendMessage(chatId, '❌ Terjadi error saat memproses permintaan.');
    }
  };
}

// Clean up disconnected sessions
async function cleanupDisconnectedSessions(userStates) {
  try {
    let cleanedCount = 0;
    
    for (const [userId, userData] of Object.entries(userStates)) {
      if (!userData.sessions) continue;
      
      for (const [slotId, sessionData] of Object.entries(userData.sessions)) {
        // Check if session is marked as connected but socket is null or disconnected
        if (sessionData.isConnected && (!sessionData.socket || sessionData.socket.readyState !== sessionData.socket.OPEN)) {
          console.log(`🧹 Cleaning up disconnected session: ${userId}/${slotId}`);
          
          // Update memory state
          sessionData.isConnected = false;
          sessionData.socket = null;
          
          // Update file state
          await UserFileManager.updateSessionInfo(userId, slotId, {
            isActive: false,
            lastConnect: new Date().toISOString()
          });
          
          cleanedCount++;
        }
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} disconnected sessions`);
    }
    
    return cleanedCount;
  } catch (error) {
    console.error('Error cleaning up sessions:', error);
    return 0;
  }
}

module.exports = {
  handleSessionCallbacks,
  handleSessionMessages,
  getActiveSession,
  getSessionBySlot,
  updateSessionName,
  initializeUserSessions,
  checkFeatureAccess,
  autoInitializeSessions,
  requirePremium,
  cleanupDisconnectedSessions
};