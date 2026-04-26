import { getApps, initializeApp } from "firebase/app";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  serverTimestamp,
  updateDoc,
  type DocumentData
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? ""
};

function assertFirebaseConfig() {
  const missingFirebaseEnv = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingFirebaseEnv.length > 0) {
    throw new Error(
      `Missing Firebase environment variables: ${missingFirebaseEnv.join(", ")}`
    );
  }
}

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const db = getFirestore(app);

export async function createIncident(data: DocumentData = {}) {
  assertFirebaseConfig();

  const incidentRef = await addDoc(collection(db, "incidents"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return incidentRef.id;
}

export async function getIncident(incidentId: string) {
  assertFirebaseConfig();

  if (!incidentId.trim()) {
    throw new Error("incidentId is required.");
  }

  const incidentSnapshot = await getDoc(doc(db, "incidents", incidentId));

  if (!incidentSnapshot.exists()) {
    return null;
  }

  return {
    id: incidentSnapshot.id,
    ...incidentSnapshot.data()
  };
}

export async function getZones(incidentId: string) {
  assertFirebaseConfig();

  if (!incidentId.trim()) {
    throw new Error("incidentId is required.");
  }

  const zonesSnapshot = await getDocs(
    collection(db, "incidents", incidentId, "zones")
  );

  return zonesSnapshot.docs.map((zoneSnapshot) => ({
    id: zoneSnapshot.id,
    ...zoneSnapshot.data()
  }));
}

export async function addZone(incidentId: string, data: DocumentData) {
  assertFirebaseConfig();

  if (!incidentId.trim()) {
    throw new Error("incidentId is required.");
  }

  const zoneRef = await addDoc(collection(db, "incidents", incidentId, "zones"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return zoneRef.id;
}

export async function updateZone(
  incidentId: string,
  zoneId: string,
  data: DocumentData
) {
  assertFirebaseConfig();

  if (!incidentId.trim()) {
    throw new Error("incidentId is required.");
  }

  if (!zoneId.trim()) {
    throw new Error("zoneId is required.");
  }

  await updateDoc(doc(db, "incidents", incidentId, "zones", zoneId), {
    ...data,
    updatedAt: serverTimestamp()
  });
}
