const { safeEditMessage } = require('../utils/helpers');
const UserFileManager = require('../utils/userFileManager');
const { PremiumPaymentManager } = require('../utils/premiumPaymentManager');

// Initialize payment manager
const paymentManager = new PremiumPaymentManager();

// Show main menu with new layout
async function showMainMenu(chatId, bot, userStates, messageId = null) {
  try {
    // Get user data
    const userData = await UserFileManager.loadUser(chatId);
    const premiumInfo = await UserFileManager.getPremiumInfo(chatId);
    
    // Check connection status
    const activeSlot = userData.activeSlot;
    const isConnected = activeSlot && userStates[chatId]?.sessions?.[activeSlot]?.isConnected || false;
    
    // Format premium status
    let premiumStatus = '';
    if (premiumInfo.isPremium) {
      const expiry = new Date(premiumInfo.expiry);
      const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
      premiumStatus = `\n🟢 Premium: ${premiumInfo.totalSlots} slot(s) - ${daysLeft} hari`;
    } else {
      premiumStatus = '\n🔴 Premium: Tidak aktif';
    }
    
    // Format active session info
    let sessionInfo = '';
    if (activeSlot && userData.sessions[activeSlot]) {
      const sessionData = userData.sessions[activeSlot];
      const sessionName = sessionData.sessionName || `Slot ${activeSlot.replace('slot_', '')}`;
      const connectionStatus = isConnected ? '✅ Connected' : '❌ Disconnected';
      sessionInfo = `\n📱 Active: ${sessionName} (${connectionStatus})`;
    } else {
      sessionInfo = '\n📱 Active: Tidak ada session aktif';
    }

    const menuText = `👋 *Welcome to Auto Accept Bot Premium!*${premiumStatus}${sessionInfo}\n\nPilih menu:`;
    
    // New menu layout - lebih rapi dan berkolom
    const keyboard = {
      inline_keyboard: [
        // Row 1: Login & Auto Accept
        [
          { text: '🔑 Login WhatsApp', callback_data: 'login' },
          { text: '🤖 Auto Accept', callback_data: 'auto_accept' }
        ],
        // Row 2: Admin Management & Add CTC
        [
          { text: '👥 Admin Management', callback_data: 'admin_management' },
          { text: '📞 Add CTC', callback_data: 'add_ctc' }
        ],
        // Row 3: Blast & Rename Groups
        [
          { text: '⚡ Blast', callback_data: 'blast' },
          { text: '✏️ Rename Groups', callback_data: 'rename_groups' }
        ],
        // Row 4: Session Manager
        [
          { text: '📱 Session Manager', callback_data: 'session_manager' }
        ],
        // Row 5: Status & Logout
        [
          { text: '🔄 Status', callback_data: 'status' },
          { text: '🚪 Logout', callback_data: 'logout' }
        ]
      ]
    };
    
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, menuText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await bot.sendMessage(chatId, menuText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error('Error showing main menu:', error);
    const fallbackText = '❌ Terjadi kesalahan saat memuat menu. Coba lagi ya!';
    
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, fallbackText);
    } else {
      await bot.sendMessage(chatId, fallbackText);
    }
  }
}

// Show Session Manager Menu
async function showSessionManager(chatId, bot, messageId = null) {
  try {
    // Check premium access
    const premiumInfo = await UserFileManager.getPremiumInfo(chatId);
    
    if (!premiumInfo.isPremium) {
      return await showPremiumRequired(chatId, bot, messageId);
    }

    // Get user data
    const userData = await UserFileManager.loadUser(chatId);
    const sessions = userData.sessions || {};
    const activeSlot = userData.activeSlot;

    let message = `📱 *Session Manager*\n\n`;
    message += `💎 Premium: ${premiumInfo.totalSlots} slot(s)\n`;
    
    const expiry = new Date(premiumInfo.expiry);
    const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
    message += `⏰ Berakhir: ${daysLeft} hari lagi\n\n`;

    // Show all slots
    const keyboard = { inline_keyboard: [] };
    
    for (let i = 1; i <= premiumInfo.totalSlots; i++) {
      const slotId = `slot_${i}`;
      const slotData = sessions[slotId];
      
      if (slotData) {
        const sessionName = slotData.sessionName || `Slot ${i}`;
        const isActive = activeSlot === slotId ? '🔥' : '';
        const isOnline = slotData.isActive ? '✅' : '❌';
        
        message += `${isActive} Slot ${i}: ${isOnline} ${sessionName}\n`;
        
        // Add slot controls
        const slotButtons = [];
        
        // Switch button (if not active)
        if (activeSlot !== slotId) {
          slotButtons.push({ 
            text: `🔄 Switch to Slot ${i}`, 
            callback_data: `switch_slot_${slotId}` 
          });
        }
        
        // Login/Logout button
        if (slotData.isActive) {
          slotButtons.push({ 
            text: `🚪 Logout Slot ${i}`, 
            callback_data: `logout_slot_${slotId}` 
          });
        } else {
          slotButtons.push({ 
            text: `🔑 Login Slot ${i}`, 
            callback_data: `login_slot_${slotId}` 
          });
        }
        
        if (slotButtons.length > 0) {
          keyboard.inline_keyboard.push(slotButtons);
        }
      } else {
        message += `⭕ Slot ${i}: Belum dikonfigurasi\n`;
        
        // Add setup button
        keyboard.inline_keyboard.push([{
          text: `⚙️ Setup Slot ${i}`,
          callback_data: `setup_slot_${slotId}`
        }]);
      }
    }

    // Add more slots button (if user can afford)
    const hasAvailableSlots = Object.keys(sessions).length < premiumInfo.totalSlots;
    if (!hasAvailableSlots) {
      keyboard.inline_keyboard.push([{
        text: '➕ Beli Slot Tambahan (+5k)',
        callback_data: 'buy_additional_slot'
      }]);
    }

    // Back button
    keyboard.inline_keyboard.push([
      { text: '« Kembali ke Menu Utama', callback_data: 'main_menu' }
    ]);

    message += `\n💡 *Tip:* Gunakan tombol di bawah untuk mengelola session WhatsApp Anda.`;

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error('Error showing session manager:', error);
    const errorText = '❌ Terjadi kesalahan saat memuat session manager.';
    
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, errorText, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'main_menu' }]]
        }
      });
    } else {
      await bot.sendMessage(chatId, errorText, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'main_menu' }]]
        }
      });
    }
  }
}

// Show Premium Required Menu
async function showPremiumRequired(chatId, bot, messageId = null) {
  try {
    const message = `🚫 *Premium Required*\n\n` +
      `Fitur Session Manager hanya tersedia untuk pengguna premium.\n\n` +
      `💎 *Paket Premium:*\n` +
      `• 1 Slot WhatsApp: Rp 15.000/bulan\n` +
      `• Slot tambahan: Rp 5.000/bulan\n` +
      `• Kelola multiple WhatsApp dalam 1 bot\n` +
      `• Priority support\n\n` +
      `Aktifkan premium sekarang untuk mulai menggunakan fitur lengkap!`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '💳 Beli Premium (15k)', callback_data: 'buy_premium_first' }],
        [{ text: '« Kembali ke Menu Utama', callback_data: 'main_menu' }]
      ]
    };

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error('Error showing premium required:', error);
  }
}

// Show Payment Menu
async function showPaymentMenu(chatId, bot, paymentType, messageId = null) {
  try {
    // Get payment info
    const paymentInfo = await paymentManager.getPaymentInfo(chatId, paymentType);
    
    if (!paymentInfo.canPurchase) {
      const errorMessage = `❌ *Tidak Dapat Membeli*\n\n${paymentInfo.reason}`;
      
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errorMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
          }
        });
      } else {
        await bot.sendMessage(chatId, errorMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
          }
        });
      }
      return;
    }

    // Create payment
    const transaction = await paymentManager.createPayment(chatId, paymentType);
    
    let message = `💳 *Pembayaran Premium*\n\n`;
    message += `📦 Paket: ${transaction.description}\n`;
    message += `💰 Harga: Rp ${transaction.base_amount.toLocaleString()}\n`;
    message += `🆔 ID Transaksi: ${transaction.id}\n\n`;
    message += `📱 Scan QR Code di bawah untuk pembayaran:\n`;
    message += `⏰ Batas waktu: 15 menit\n\n`;
    message += `💡 *Catatan:* Pembayaran akan diproses otomatis setelah transfer berhasil.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Cek Status Pembayaran', callback_data: `check_payment_${transaction.id}` }],
        [{ text: '❌ Batalkan Pembayaran', callback_data: `cancel_payment_${transaction.id}` }],
        [{ text: '« Kembali', callback_data: 'session_manager' }]
      ]
    };

    // Send QR Code
    const qrBuffer = Buffer.from(transaction.qris_url.split(',')[1], 'base64');
    
    if (messageId) {
      // Delete old message and send new one with photo
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (err) {
        console.warn('Could not delete message:', err.message);
      }
    }
    
    await bot.sendPhoto(chatId, qrBuffer, {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });

  } catch (error) {
    console.error('Error showing payment menu:', error);
    const errorText = '❌ Terjadi kesalahan saat membuat pembayaran. Coba lagi nanti.';
    
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, errorText, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
        }
      });
    } else {
      await bot.sendMessage(chatId, errorText, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
        }
      });
    }
  }
}

// Check payment status
async function checkPaymentStatus(chatId, bot, transactionId, messageId = null) {
  try {
    const result = await paymentManager.checkPaymentStatus(transactionId);
    
    let message;
    let keyboard;
    
    switch (result.status) {
      case 'paid':
        message = `✅ *Pembayaran Berhasil!*\n\n` +
          `🆔 ID Transaksi: ${transactionId}\n` +
          `💰 Jumlah: Rp ${result.transaction.base_amount.toLocaleString()}\n` +
          `📦 Paket: ${result.transaction.description}\n\n` +
          `🎉 Premium Anda telah diaktifkan!\n` +
          `Silahkan kembali ke Session Manager untuk mulai menggunakan fitur premium.`;
        
        keyboard = {
          inline_keyboard: [
            [{ text: '📱 Buka Session Manager', callback_data: 'session_manager' }],
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        };
        break;
        
      case 'pending':
        message = `⏳ *Menunggu Pembayaran*\n\n` +
          `🆔 ID Transaksi: ${transactionId}\n` +
          `💰 Jumlah: Rp ${result.transaction.base_amount.toLocaleString()}\n\n` +
          `💡 Silahkan lakukan pembayaran melalui QR Code yang telah diberikan.\n` +
          `Status akan diperbarui otomatis setelah pembayaran berhasil.`;
        
        keyboard = {
          inline_keyboard: [
            [{ text: '🔄 Refresh Status', callback_data: `check_payment_${transactionId}` }],
            [{ text: '❌ Batalkan', callback_data: `cancel_payment_${transactionId}` }],
            [{ text: '« Kembali', callback_data: 'session_manager' }]
          ]
        };
        break;
        
      case 'expired':
        message = `⏰ *Pembayaran Kedaluwarsa*\n\n` +
          `🆔 ID Transaksi: ${transactionId}\n\n` +
          `Batas waktu pembayaran telah habis. Silahkan buat transaksi baru jika masih ingin membeli.`;
        
        keyboard = {
          inline_keyboard: [
            [{ text: '💳 Buat Pembayaran Baru', callback_data: 'buy_premium_first' }],
            [{ text: '« Kembali', callback_data: 'session_manager' }]
          ]
        };
        break;
        
      case 'not_found':
        message = `❌ *Transaksi Tidak Ditemukan*\n\n` +
          `ID Transaksi: ${transactionId}\n\n` +
          `Transaksi tidak ditemukan atau sudah diproses.`;
        
        keyboard = {
          inline_keyboard: [
            [{ text: '« Kembali', callback_data: 'session_manager' }]
          ]
        };
        break;
        
      default:
        message = `❌ *Error*\n\nTerjadi kesalahan saat mengecek status pembayaran.`;
        
        keyboard = {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: `check_payment_${transactionId}` }],
            [{ text: '« Kembali', callback_data: 'session_manager' }]
          ]
        };
    }

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error('Error checking payment status:', error);
    const errorText = '❌ Terjadi kesalahan saat mengecek status pembayaran.';
    
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, errorText, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
        }
      });
    } else {
      await bot.sendMessage(chatId, errorText, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'session_manager' }]]
        }
      });
    }
  }
}

// Cancel payment
async function cancelPayment(chatId, bot, transactionId, messageId = null) {
  try {
    const success = await paymentManager.cancelPayment(transactionId);
    
    const message = success 
      ? `✅ *Pembayaran Dibatalkan*\n\nTransaksi ${transactionId} telah dibatalkan.`
      : `❌ *Gagal Membatalkan*\n\nTransaksi tidak ditemukan atau sudah diproses.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '« Kembali ke Session Manager', callback_data: 'session_manager' }]
      ]
    };

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error('Error cancelling payment:', error);
  }
}

module.exports = {
  showMainMenu,
  showSessionManager,
  showPremiumRequired,
  showPaymentMenu,
  checkPaymentStatus,
  cancelPayment,
  paymentManager // Export untuk digunakan di tempat lain
};