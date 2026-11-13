import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  doc,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDHsNLgCoWGXjJ2nKqOT2wiPzO6ofod_dA",
  authDomain: "acompanhamento-obras-a9367.firebaseapp.com",
  projectId: "acompanhamento-obras-a9367",
  storageBucket: "acompanhamento-obras-a9367.firebasestorage.app",
  messagingSenderId: "507503560478",
  appId: "1:507503560478:web:a337219e219c8b2b2feb0f",
};

const EDITOR_EMAIL = "bianca.andrade@attosementes.com.br";
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const projectRef = doc(db, "projects", "secadorDashboard");

let unsubscribeProject = null;
let lastRemoteData = null;
let saveTimer = null;
let saveRevision = 0;
let localSavePending = false;

function isEditor() {
  return auth.currentUser && auth.currentUser.email === EDITOR_EMAIL;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function structureSignature(data) {
  return JSON.stringify(data.map(group => ({
    id: group.id,
    taskIds: (group.tasks || []).map(task => task.id),
  })));
}

function mergeChangedProperties(base, local, target, excludedKeys) {
  const keys = new Set([...Object.keys(base), ...Object.keys(local)]);
  keys.forEach(key => {
    if (excludedKeys.has(key)) return;
    if (JSON.stringify(base[key]) === JSON.stringify(local[key])) return;
    if (Object.prototype.hasOwnProperty.call(local, key)) target[key] = clone(local[key]);
    else delete target[key];
  });
}

function mergeProjectData(base, local, remote) {
  if (!Array.isArray(base) || !Array.isArray(local) || !Array.isArray(remote)) return clone(local);
  if (structureSignature(base) !== structureSignature(local)) return clone(local);

  const merged = clone(remote);
  local.forEach(localGroup => {
    const baseGroup = base.find(group => group.id === localGroup.id);
    const remoteGroup = merged.find(group => group.id === localGroup.id);
    if (!baseGroup || !remoteGroup) return;

    mergeChangedProperties(baseGroup, localGroup, remoteGroup, new Set(["tasks"]));
    (localGroup.tasks || []).forEach(localTask => {
      const baseTask = (baseGroup.tasks || []).find(task => task.id === localTask.id);
      const remoteTask = (remoteGroup.tasks || []).find(task => task.id === localTask.id);
      if (baseTask && remoteTask) {
        mergeChangedProperties(baseTask, localTask, remoteTask, new Set());
      }
    });
  });
  return merged;
}

function setSyncStatus(message, state) {
  if (window.setSyncStatus) window.setSyncStatus(message, state);
}

function reportSyncError(error) {
  console.error("Erro de sincronizaÃ§Ã£o com o Firestore:", error);
  setSyncStatus("Falha na sincronizaÃ§Ã£o", "error");
}

async function saveProjectData(revision) {
  if (!isEditor() || !unsubscribeProject) return;
  const localData = clone(window.getProjectData());
  if (lastRemoteData && JSON.stringify(localData) === JSON.stringify(lastRemoteData)) {
    if (revision === saveRevision) localSavePending = false;
    return;
  }
  const baseData = lastRemoteData ? clone(lastRemoteData) : null;
  let savedData = localData;

  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(projectRef);
    if (!snapshot.exists()) throw new Error("O documento do projeto nÃ£o existe no Firestore.");
    const remoteData = snapshot.data().projectData;
    savedData = mergeProjectData(baseData, localData, remoteData);
    transaction.set(projectRef, {
      projectData: savedData,
      updatedAt: serverTimestamp(),
    });
  });

  if (revision === saveRevision) {
    lastRemoteData = clone(savedData);
    localSavePending = false;
  }
  setSyncStatus("Sincronizado", "connected");
}

window.queueFirestoreSave = function() {
  if (!isEditor() || !unsubscribeProject) return;
  saveRevision++;
  const revision = saveRevision;
  localSavePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProjectData(revision).catch(reportSyncError);
  }, 400);
};

window.startFirestoreSync = async function(initialData) {
  if (unsubscribeProject) return;
  setSyncStatus("Conectando ao Firestore...", "loading");

  try {
    if (isEditor()) {
      await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(projectRef);
        if (!snapshot.exists()) {
          transaction.set(projectRef, {
            projectData: initialData,
            updatedAt: serverTimestamp(),
          });
        }
      });
    }

    unsubscribeProject = onSnapshot(projectRef, snapshot => {
      if (!snapshot.exists()) {
        setSyncStatus("Projeto nÃ£o encontrado", "error");
        return;
      }
      const remoteData = snapshot.data().projectData;
      if (!Array.isArray(remoteData)) {
        setSyncStatus("Dados do Firestore invÃ¡lidos", "error");
        return;
      }
      const currentData = window.getProjectData();
      const dataToApply = localSavePending && lastRemoteData
        ? mergeProjectData(lastRemoteData, currentData, remoteData)
        : remoteData;
      lastRemoteData = clone(remoteData);
      if (JSON.stringify(dataToApply) !== JSON.stringify(currentData)) {
        window.applyRemoteProjectData(dataToApply);
      }
      setSyncStatus("Sincronizado", "connected");
      if (window.onFirestoreReady) window.onFirestoreReady();
    }, reportSyncError);
  } catch (error) {
    reportSyncError(error);
    throw error;
  }
};

window.stopFirestoreSync = function() {
  clearTimeout(saveTimer);
  saveTimer = null;
  localSavePending = false;
  if (unsubscribeProject) unsubscribeProject();
  unsubscribeProject = null;
  lastRemoteData = null;
};

window.firebaseSignIn = (email, password) =>
  signInWithEmailAndPassword(auth, email, password);
window.firebaseCanEdit = isEditor;
window.firebaseSendPasswordResetEmail = email =>
  sendPasswordResetEmail(auth, email);
window.firebaseSignOut = () => signOut(auth);

onAuthStateChanged(auth, user => {
  if (window.onFirebaseAuthChanged) {
    Promise.resolve(window.onFirebaseAuthChanged(user)).catch(reportSyncError);
  }
}, reportSyncError);
