import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, addDoc, getDoc, orderBy, runTransaction } from 'firebase/firestore';
import { Play, Square, Trash2, Calendar, Loader2 } from 'lucide-react';

const ENV_APP_ID = typeof __app_id !== 'undefined' ? __app_id : null;
const ENV_FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const ENV_INITIAL_AUTH_TOKEN = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const EXTERNAL_FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};


const firebaseConfig = ENV_FIREBASE_CONFIG || EXTERNAL_FIREBASE_CONFIG;
const appId = ENV_APP_ID || EXTERNAL_FIREBASE_CONFIG.projectId || 'default-app-id'; 
const initialAuthToken = ENV_INITIAL_AUTH_TOKEN;

const dateHelpers = {
  // Convert minutes to a formatted HH:MM string
  formatDuration: (minutes) => {
    if (minutes === null || isNaN(minutes)) return '0:00';
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    return `${h}:${m.toString().padStart(2, '0')}`;
  },
  // Get the start of the current week (Sunday)
  getWeekStart: (date) => {
    const d = new Date(date);
    const day = d.getDay(); // 0 is Sunday
    const diff = d.getDate() - day;
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  },
  // Get the start of the biweek (e.g., if biweekly starts on Jan 1, it groups 1-14, 15-28, etc.)
  getBiweekStart: (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const dayOfMonth = d.getDate();
    const period = dayOfMonth <= 15 ? 1 : 16;
    d.setDate(period);
    return d;
  },
  // Get the start of the month
  getMonthStart: (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d;
  },
  // Format a Date object to readable time (HH:MM:SS)
  formatTime: (date) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  },
  // Format a Date object to readable date (MM/DD/YYYY)
  formatDate: (date) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('en-US');
  }
};

const TimePeriodOptions = [
  { value: 'weekly', label: 'Weekly Total' },
  { value: 'biweekly', label: 'Biweekly Total' },
  { value: 'monthly', label: 'Monthly Total' },
];

// Main App Component
const App = () => {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [isTracking, setIsTracking] = useState(false);
  const [totalPeriod, setTotalPeriod] = useState('weekly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [jobInput, setJobInput] = useState(''); // New state for job name input

  // 1. FIREBASE INITIALIZATION AND AUTHENTICATION
  useEffect(() => {
    if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.includes('YOUR_API_KEY')) {
      setError("Firebase API Key is missing or invalid. Check the configuration block at the top of the file.");
      setLoading(false);
      return;
    }

    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authentication = getAuth(app);
      
      setDb(firestore);
      setAuth(authentication);

      // Listen for auth state changes
      const unsubscribe = onAuthStateChanged(authentication, async (user) => {
        if (user) {
          setUserId(user.uid);
        } else {
          // Authenticate using the environment token, or fall back to anonymous sign-in
          try {
            if (initialAuthToken) {
                // Use custom token provided by the environment
                await signInWithCustomToken(authentication, initialAuthToken);
            } else {
                // Sign in anonymously (for external or fallback use)
                await signInAnonymously(authentication);
            }
          } catch (e) {
            console.error("Auth failed:", e);
            setError("Authentication failed. Please check console for details.");
          }
        }
        setIsAuthReady(true);
        setLoading(false);
      });

      return () => unsubscribe();
    } catch (e) {
      console.error("Firebase Initialization Error:", e);
      setError("Failed to initialize Firebase.");
      setLoading(false);
    }
  }, []);

  // 2. FIRESTORE DATA LISTENER (onSnapshot)
  useEffect(() => {
    if (!db || !isAuthReady || !userId) return;

    const sessionCollectionPath = `artifacts/${appId}/users/${userId}/sessions`;
    const q = query(collection(db, sessionCollectionPath), orderBy("start_time", "desc"));
    
    // Set up a real-time listener
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedSessions = snapshot.docs.map(doc => {
        const data = doc.data();
        // Convert Firestore Timestamps to JS Dates
        return {
          id: doc.id,
          ...data,
          start_time: data.start_time?.toDate(),
          end_time: data.end_time?.toDate(),
        };
      });

      setSessions(fetchedSessions);

      // Check if there is an active (unstopped) session
      const activeSession = fetchedSessions.find(s => !s.end_time);
      setIsTracking(!!activeSession);
      // Pre-fill input if a session is active
      if (activeSession) {
        setJobInput(activeSession.jobName || '');
      } else if (isTracking) {
        // Only clear if tracking state changed to false, and the input wasn't updated by a live session
        setJobInput(''); 
      }

      console.log(`Real-time update: ${fetchedSessions.length} sessions loaded.`);
    }, (e) => {
        console.error("Firestore listen error:", e);
        setError("Failed to load sessions in real-time.");
    });

    return () => unsubscribe();
  }, [db, isAuthReady, userId]);

  // 3. CORE LOGIC: START / STOP / DELETE

  const startTracking = useCallback(async () => {
    if (!db || !userId) return;
    try {
      const sessionCollectionPath = `artifacts/${appId}/users/${userId}/sessions`;
      const now = new Date();
      
      await addDoc(collection(db, sessionCollectionPath), {
        start_time: now,
        end_time: null, // Session is active
        duration: null, // Duration is TBD
        jobName: jobInput.trim() || 'Unspecified Project', // Save job name
      });
      // Don't clear jobInput here; let the onSnapshot handle setting the active job name

    } catch (e) {
      console.error("Error starting session:", e);
      setError("Could not start session. Please try again.");
    }
  }, [db, userId, jobInput]);

  const stopTracking = useCallback(async () => {
    if (!db || !userId) return;

    try {
      const activeSession = sessions.find(s => !s.end_time);
      if (!activeSession) {
        console.warn("No active session found to stop.");
        return;
      }

      const now = new Date();
      const startTime = activeSession.start_time;
      
      // Duration in minutes
      const durationMs = now.getTime() - startTime.getTime();
      const durationMinutes = Math.round(durationMs / (1000 * 60)); // Round to nearest minute

      const docRef = doc(db, `artifacts/${appId}/users/${userId}/sessions`, activeSession.id);
      
      await updateDoc(docRef, {
        end_time: now,
        duration: durationMinutes, // Store duration in minutes
      });

      // Clear the input after stopping
      setJobInput('');
      
    } catch (e) {
      console.error("Error stopping session:", e);
      setError("Could not stop session. Please check the console.");
    }
  }, [db, userId, sessions]);

  const deleteSession = useCallback(async (sessionId) => {
    if (!db || !userId) return;
    // NOTE: Replace window.confirm with a custom modal in a production app
    if (!window.confirm("Are you sure you want to delete this work session?")) return; 

    try {
      const docRef = doc(db, `artifacts/${appId}/users/${userId}/sessions`, sessionId);
      await deleteDoc(docRef);
    } catch (e) {
      console.error("Error deleting session:", e);
      setError("Could not delete session. Check the console.");
    }
  }, [db, userId]);

  // 4. TOTALS CALCULATION
  const groupedSessions = useMemo(() => {
    if (!sessions.length) return {};

    const groups = {};
    let getPeriodStart;
    
    // Select the appropriate grouping function
    if (totalPeriod === 'monthly') {
      getPeriodStart = dateHelpers.getMonthStart;
    } else if (totalPeriod === 'biweekly') {
      getPeriodStart = dateHelpers.getBiweekStart;
    } else { // default to weekly
      getPeriodStart = dateHelpers.getWeekStart;
    }

    let totalDurationMinutes = 0;

    sessions.forEach(session => {
      // Only count sessions that have an end time (completed)
      if (session.duration === null) return; 

      const periodStartDate = getPeriodStart(session.start_time);
      const periodKey = periodStartDate.toISOString().split('T')[0];
      
      if (!groups[periodKey]) {
        groups[periodKey] = {
          start: periodStartDate,
          sessions: [],
          totalMinutes: 0
        };
      }

      groups[periodKey].sessions.push(session);
      groups[periodKey].totalMinutes += session.duration;
      totalDurationMinutes += session.duration;
    });

    // Sort groups by start date descending
    const sortedGroupKeys = Object.keys(groups).sort((a, b) => new Date(b) - new Date(a));
    const sortedGroups = sortedGroupKeys.map(key => groups[key]);

    return { sortedGroups, totalDurationMinutes };
  }, [sessions, totalPeriod]);

  const totalMinutesAcrossAllPeriods = groupedSessions.totalDurationMinutes || 0;

  // --- RENDERING ---

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <p className="ml-3 text-lg font-medium text-indigo-700">Connecting to HourTrack...</p>
      </div>
    );
  }

 return (
    <div className="min-w-screen bg-gray-50 py-10 sm:py-8 px-0 font-sans">
      <div className="w-full py-10 px-20">
        
        {/* Header & Status */}
        <header className="text-center mb-6">
          <h1 className="text-4xl font-extrabold text-gray-900 tracking-tight">
            HourTrack
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            User ID: <span className="font-mono text-xs p-1 bg-indigo-100 rounded-md select-all">{userId || 'N/A'}</span>
          </p>
        </header>

        {error && (
          <div className="p-4 mb-4 text-sm text-red-700 bg-red-100 rounded-lg shadow-md" role="alert">
            <span className="font-medium">Error:</span> {error}
          </div>
        )}

        {/* Start/Stop Card */}
        <div className="bg-white p-6 rounded-2xl shadow-xl mb-8 border-t-4 border-indigo-500">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-800">Time Clock Status</h2>
            {isTracking ? (
              <div className="flex items-center space-x-2 text-green-600">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                </span>
                <span className="font-medium">Tracking...</span>
              </div>
            ) : (
              <span className="text-gray-500">Ready to Start</span>
            )}
          </div>
          
          {/* Input for Job Name */}
          <div className="mt-4">
            <label htmlFor="jobName" className="block text-sm font-medium text-gray-700 mb-1">
              Job / Project Name (Optional)
            </label>
            <input
              type="text"
              id="jobName"
              value={jobInput}
              onChange={(e) => setJobInput(e.target.value)}
              placeholder={isTracking ? 'Currently active job...' : 'e.g., Client Website Redesign'}
              disabled={isTracking || !isAuthReady}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50 disabled:cursor-not-allowed text-gray-800"
            />
          </div>

          <div className="mt-4">
            <button
              onClick={isTracking ? stopTracking : startTracking}
              disabled={!isAuthReady}
              className={`w-full py-4 text-lg font-bold rounded-xl transition-all duration-300 transform hover:scale-[1.01] shadow-lg ${
                isTracking
                  ? 'bg-red-500 hover:bg-red-600 text-white flex items-center justify-center space-x-2'
                  : 'bg-indigo-500 hover:bg-indigo-600 text-white flex items-center justify-center space-x-2'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isTracking ? (
                <>
                  <Square className="w-6 h-6" />
                  <span>STOP WORK</span>
                </>
              ) : (
                <>
                  <Play className="w-6 h-6" />
                  <span>START WORK</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Totals Summary */}
        <div className="bg-white p-6 rounded-2xl shadow-xl mb-8">
            <h2 className="text-xl font-semibold text-gray-800 mb-4">Total Hours Summary</h2>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
                <div className="flex items-center space-x-2">
                    <Calendar className="w-5 h-5 text-indigo-500" />
                    <select
                        value={totalPeriod}
                        onChange={(e) => setTotalPeriod(e.target.value)}
                        className="p-2 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 text-gray-700 font-medium"
                    >
                        {TimePeriodOptions.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                </div>
                <div className="text-right">
                    <p className="text-sm font-medium text-gray-500">Total Hours Logged ({totalPeriod}):</p>
                    <p className="text-3xl font-extrabold text-indigo-600">
                        {dateHelpers.formatDuration(totalMinutesAcrossAllPeriods)}
                    </p>
                </div>
            </div>
        </div>

        {/* Sessions Table */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <h2 className="text-2xl font-bold text-gray-800 p-6">Work Sessions</h2>
          
          <div className="divide-y divide-gray-100">
            {groupedSessions.sortedGroups?.length > 0 ? (
              groupedSessions.sortedGroups.map((group, groupIndex) => (
                <div key={group.start.toISOString()} className="group-item">
                  {/* Period Header */}
                  <div className="bg-gray-100 px-6 py-3 border-b border-gray-200">
                    <p className="text-lg font-bold text-gray-800 flex items-center justify-between">
                        {totalPeriod === 'weekly' && `Week of ${dateHelpers.formatDate(group.start)}`}
                        {totalPeriod === 'biweekly' && `Biweek starting ${dateHelpers.formatDate(group.start)}`}
                        {totalPeriod === 'monthly' && `Month of ${group.start.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`}
                        <span className="text-indigo-600 font-extrabold text-xl">
                            Total: {dateHelpers.formatDuration(group.totalMinutes)}
                        </span>
                    </p>
                  </div>
                  
                  {/* Sessions within the period */}
                  <div className="w-full overflow-x-auto">
                    <table className="w-full table-fixed divide-y divide-gray-200">
                      <thead className="bg-white">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Project</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Start</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Stop</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Duration (H:M)</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-100">
                        {group.sessions.map((session) => (
                          <tr key={session.id} className={!session.end_time ? 'bg-yellow-50/50' : ''}>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                              {dateHelpers.formatDate(session.start_time)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-800 font-semibold">
                              {session.jobName || 'Unspecified Project'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {dateHelpers.formatTime(session.start_time)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {session.end_time ? dateHelpers.formatTime(session.end_time) : (
                                <span className="font-semibold text-yellow-600">IN PROGRESS</span>
                              )}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-right text-gray-500">
                              {session.duration !== null ? dateHelpers.formatDuration(session.duration) : '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                              <button
                                onClick={() => deleteSession(session.id)}
                                title="Delete Session"
                                className="text-red-600 hover:text-red-900 p-2 rounded-full hover:bg-red-50 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-6 text-center text-gray-500">
                {isTracking ? "Session in progress..." : "No completed work sessions logged yet."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Required wrapper to integrate with the environment
export default App;