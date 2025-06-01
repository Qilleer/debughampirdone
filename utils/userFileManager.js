const fs = require('fs');
const path = require('path');
const config = require('../config');

// Base directories
const USERS_DIR = path.join(process.cwd(), 'data/users');
const SESSIONS_DIR = path.join(process.cwd(), 'data/sessions');

class UserFileManager {
  // Initialize directories
  static async initializeDirectories() {
    try {
      // Create users directory
      if (!fs.existsSync(USERS_DIR)) {
        fs.mkdirSync(USERS_DIR, { recursive: true });
        console.log('✅ Created users directory');
      }

      // Create sessions directory  
      if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        console.log('✅ Created sessions directory');
      }

      return true;
    } catch (error) {
      console.error('❌ Error initializing directories:', error);
      return false;
    }
  }

  // Get user file path
  static getUserFilePath(userId) {
    return path.join(USERS_DIR, `${userId}.json`);
  }

  // Get session directory path
  static getSessionDirPath(userId, slotId) {
    return path.join(SESSIONS_DIR, `wa_${userId}_${slotId}`);
  }

  // Load user data
  static async loadUser(userId) {
    try {
      const filePath = this.getUserFilePath(userId);
      
      if (!fs.existsSync(filePath)) {
        // Return default user structure
        return this.createDefaultUser(userId);
      }

      const data = fs.readFileSync(filePath, 'utf8');
      const userData = JSON.parse(data);
      
      // Validate and migrate old structure if needed
      return this.validateUserStructure(userData);
    } catch (error) {
      console.error(`Error loading user ${userId}:`, error);
      return this.createDefaultUser(userId);
    }
  }

  // Save user data
  static async saveUser(userId, userData) {
    try {
      const filePath = this.getUserFilePath(userId);
      
      // Create backup before save
      if (fs.existsSync(filePath)) {
        const backupPath = `${filePath}.backup`;
        fs.copyFileSync(filePath, backupPath);
      }

      // Add metadata
      userData.lastUpdated = new Date().toISOString();
      
      // Write to file
      fs.writeFileSync(filePath, JSON.stringify(userData, null, 2));
      
      console.log(`✅ Saved user data for ${userId}`);
      return true;
    } catch (error) {
      console.error(`Error saving user ${userId}:`, error);
      return false;
    }
  }

  // Create default user structure
  static createDefaultUser(userId) {
    return {
      userId: userId,
      username: null,
      first_name: null,
      joined_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      premium: {
        expiry: null, // No premium by default
        totalSlots: 0,
        lastPayment: null,
        paymentHistory: []
      },
      sessions: {},
      activeSlot: null,
      lastUpdated: new Date().toISOString()
    };
  }

  // Validate and fix user structure
  static validateUserStructure(userData) {
    // Ensure all required fields exist
    if (!userData.userId) userData.userId = userData.userId || 'unknown';
    if (!userData.premium) userData.premium = {
      expiry: null,
      totalSlots: 0,
      lastPayment: null,
      paymentHistory: []
    };
    if (!userData.sessions) userData.sessions = {};
    if (!userData.activeSlot) userData.activeSlot = null;
    
    // Migrate old autoAccept if exists
    if (userData.autoAccept && !userData.sessions.slot_1) {
      userData.sessions.slot_1 = {
        sessionName: null,
        autoAccept: userData.autoAccept,
        lastConnect: userData.last_seen,
        isActive: false
      };
      delete userData.autoAccept;
    }

    return userData;
  }

  // Check if user has premium access
  static async isPremiumUser(userId) {
    try {
      const userData = await this.loadUser(userId);
      
      if (!userData.premium.expiry) return false;
      
      const expiry = new Date(userData.premium.expiry);
      const now = new Date();
      
      return expiry > now;
    } catch (error) {
      console.error(`Error checking premium status for ${userId}:`, error);
      return false;
    }
  }

  // Get user's premium info
  static async getPremiumInfo(userId) {
    try {
      const userData = await this.loadUser(userId);
      return {
        isPremium: await this.isPremiumUser(userId),
        expiry: userData.premium.expiry,
        totalSlots: userData.premium.totalSlots,
        lastPayment: userData.premium.lastPayment
      };
    } catch (error) {
      console.error(`Error getting premium info for ${userId}:`, error);
      return {
        isPremium: false,
        expiry: null,
        totalSlots: 0,
        lastPayment: null
      };
    }
  }

  // Add premium to user
  static async addPremium(userId, durationDays = 30, additionalSlots = 1) {
    try {
      const userData = await this.loadUser(userId);
      
      const now = new Date();
      let expiry;
      
      // If already premium, extend from current expiry
      if (userData.premium.expiry) {
        const currentExpiry = new Date(userData.premium.expiry);
        expiry = currentExpiry > now ? currentExpiry : now;
      } else {
        expiry = now;
      }
      
      // Add duration
      expiry.setDate(expiry.getDate() + durationDays);
      
      // Update premium info
      userData.premium.expiry = expiry.toISOString();
      userData.premium.totalSlots += additionalSlots;
      userData.premium.lastPayment = now.toISOString();

      // Create default slot if first time
      if (additionalSlots > 0 && Object.keys(userData.sessions).length === 0) {
        userData.sessions.slot_1 = {
          sessionName: null,
          autoAccept: { enabled: false },
          lastConnect: null,
          isActive: false
        };
        userData.activeSlot = 'slot_1';
      }

      return await this.saveUser(userId, userData);
    } catch (error) {
      console.error(`Error adding premium for ${userId}:`, error);
      return false;
    }
  }

  // Add payment record
  static async addPaymentRecord(userId, amount, type, trxId) {
    try {
      const userData = await this.loadUser(userId);
      
      const paymentRecord = {
        date: new Date().toISOString(),
        amount: amount,
        type: type, // 'first_slot', 'additional_slot', 'renewal'
        trx_id: trxId
      };

      userData.premium.paymentHistory.push(paymentRecord);
      
      return await this.saveUser(userId, userData);
    } catch (error) {
      console.error(`Error adding payment record for ${userId}:`, error);
      return false;
    }
  }

  // Get available slot for new session
  static async getNextAvailableSlot(userId) {
    try {
      const userData = await this.loadUser(userId);
      
      // Check if user has available slots
      const usedSlots = Object.keys(userData.sessions).length;
      const totalSlots = userData.premium.totalSlots;
      
      if (usedSlots >= totalSlots) {
        return null; // No available slots
      }

      // Find next slot number
      let slotNumber = 1;
      while (userData.sessions[`slot_${slotNumber}`]) {
        slotNumber++;
      }

      return `slot_${slotNumber}`;
    } catch (error) {
      console.error(`Error getting next slot for ${userId}:`, error);
      return null;
    }
  }

  // Create new session slot
  static async createSessionSlot(userId, slotId) {
    try {
      const userData = await this.loadUser(userId);
      
      // Check if slot already exists
      if (userData.sessions[slotId]) {
        return false;
      }

      // Create new slot
      userData.sessions[slotId] = {
        sessionName: null,
        autoAccept: { enabled: false },
        lastConnect: null,
        isActive: false
      };

      // Set as active if it's the first slot
      if (!userData.activeSlot) {
        userData.activeSlot = slotId;
      }

      return await this.saveUser(userId, userData);
    } catch (error) {
      console.error(`Error creating session slot for ${userId}:`, error);
      return false;
    }
  }

  // Switch active slot
  static async switchActiveSlot(userId, slotId) {
    try {
      const userData = await this.loadUser(userId);
      
      // Check if slot exists
      if (!userData.sessions[slotId]) {
        return false;
      }

      userData.activeSlot = slotId;
      
      return await this.saveUser(userId, userData);
    } catch (error) {
      console.error(`Error switching slot for ${userId}:`, error);
      return false;
    }
  }

  // Update session info (name, autoAccept, etc)
  static async updateSessionInfo(userId, slotId, updates) {
    try {
      const userData = await this.loadUser(userId);
      
      // Check if slot exists
      if (!userData.sessions[slotId]) {
        return false;
      }

      // Update session data
      userData.sessions[slotId] = {
        ...userData.sessions[slotId],
        ...updates
      };

      return await this.saveUser(userId, userData);
    } catch (error) {
      console.error(`Error updating session info for ${userId}:`, error);
      return false;
    }
  }

  // Get all users (for migration or admin purposes)
  static async getAllUsers() {
    try {
      const userFiles = fs.readdirSync(USERS_DIR).filter(file => file.endsWith('.json'));
      const users = {};

      for (const file of userFiles) {
        const userId = file.replace('.json', '');
        users[userId] = await this.loadUser(userId);
      }

      return users;
    } catch (error) {
      console.error('Error getting all users:', error);
      return {};
    }
  }

  // Migration from old users.json format
  static async migrateFromOldFormat(oldUsersPath = './data/users.json') {
    try {
      if (!fs.existsSync(oldUsersPath)) {
        console.log('No old users.json found, skipping migration');
        return true;
      }

      console.log('🔄 Starting migration from old users.json format...');
      
      const oldData = JSON.parse(fs.readFileSync(oldUsersPath, 'utf8'));
      let migratedCount = 0;

      for (const [userId, oldUserData] of Object.entries(oldData)) {
        try {
          // Create new user structure
          const newUserData = this.createDefaultUser(userId);
          
          // Migrate basic info
          newUserData.username = oldUserData.username;
          newUserData.first_name = oldUserData.first_name;
          newUserData.joined_at = oldUserData.joined_at || new Date().toISOString();
          newUserData.last_seen = oldUserData.last_seen || new Date().toISOString();

          // Give default premium (1 month) for existing users
          newUserData.premium.expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          newUserData.premium.totalSlots = 1;
          newUserData.premium.lastPayment = new Date().toISOString();

          // Migrate session data if exists
          if (oldUserData.autoAccept) {
            newUserData.sessions.slot_1 = {
              sessionName: null,
              autoAccept: oldUserData.autoAccept,
              lastConnect: oldUserData.last_seen,
              isActive: false
            };
            newUserData.activeSlot = 'slot_1';
          }

          // Save migrated user
          await this.saveUser(userId, newUserData);
          migratedCount++;
        } catch (userError) {
          console.error(`Error migrating user ${userId}:`, userError);
        }
      }

      // Backup old file
      const backupPath = `${oldUsersPath}.backup.${Date.now()}`;
      fs.copyFileSync(oldUsersPath, backupPath);
      
      console.log(`✅ Migration completed! ${migratedCount} users migrated`);
      console.log(`📦 Old file backed up to: ${backupPath}`);
      
      return true;
    } catch (error) {
      console.error('❌ Migration failed:', error);
      return false;
    }
  }
}

module.exports = UserFileManager;