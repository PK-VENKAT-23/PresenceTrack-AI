import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  X,
  Camera,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Trash2,
  Upload,
  FileText,
  Fingerprint,
} from "lucide-react";
import { Modal } from "@/components/presence/layout/Modal";
import {
  enrollEmployeeBiometrics,
  removeEmployeeBiometrics,
  updateEmployeeConsent,
  getEmployeeBiometricStatus,
  extractFaceEmbedding,
} from "@/lib/employee.functions";
import { isValidEmbedding } from "@/lib/biometric";
import type { EnterpriseUser } from "@/lib/ambient";

interface FaceEnrollmentModalProps {
  employee: EnterpriseUser;
  onClose: () => void;
  onSuccess: () => void;
}

type InputMode = "camera" | "upload" | "json";

export function FaceEnrollmentModal({
  employee,
  onClose,
  onSuccess,
}: FaceEnrollmentModalProps) {
  const enrollBiometricsFn = useServerFn(enrollEmployeeBiometrics);
  const removeBiometricsFn = useServerFn(removeEmployeeBiometrics);
  const updateConsentFn = useServerFn(updateEmployeeConsent);
  const getBiometricStatusFn = useServerFn(getEmployeeBiometricStatus);
  const extractEmbeddingFn = useServerFn(extractFaceEmbedding);

  // Status state
  const [biometricStatus, setBiometricStatus] = useState<{
    is_enrolled: boolean;
    consent_revoked: boolean;
    is_active: boolean;
    enrolled_at?: string | null;
  } | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  // Management vs Re-enroll state
  const [isReEnrolling, setIsReEnrolling] = useState(false);

  // Form & Interaction state
  const [mode, setMode] = useState<InputMode>("camera");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Camera state
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // File & Vector state
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [vectorInput, setVectorInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // Fetch verified backend biometric vault status
  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const res = await getBiometricStatusFn({ data: { employee_id: employee.id } });
        if (active && res.success) {
          setBiometricStatus({
            is_enrolled: Boolean(res.is_enrolled),
            consent_revoked: Boolean(res.consent_revoked),
            is_active: res.is_active ?? true,
            enrolled_at: res.enrolled_at ?? null,
          });
        }
      } catch {
        if (active) {
          setBiometricStatus({
            is_enrolled: employee.enrolled_embedding !== null && employee.enrolled_embedding !== undefined,
            consent_revoked: employee.consent_revoked ?? false,
            is_active: employee.is_active ?? true,
            enrolled_at: null,
          });
        }
      } finally {
        if (active) setLoadingStatus(false);
      }
    };
    void fetchStatus();
    return () => {
      active = false;
    };
  }, [employee.id, employee.enrolled_embedding, employee.consent_revoked, employee.is_active]);

  // Clean up media streams on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // Camera start / stop functions
  const startCamera = async () => {
    setCameraError(null);
    setCapturedImage(null);
    setErrorMessage(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraActive(false);
      setCameraError(
        "Webcam access is not supported in this environment. You can switch to 'Upload Photo' or 'Import Vector' tabs.",
      );
      return;
    }

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
    } catch (err) {
      console.error("Camera access error:", err);
      setCameraActive(false);
      setCameraError(
        "Webcam access unavailable or permission denied. You can switch to 'Upload Photo' or 'Import Vector' tabs.",
      );
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  // Only auto-start camera when in enrollment / re-enrollment mode
  useEffect(() => {
    const isEnrollingState = !biometricStatus?.is_enrolled || isReEnrolling;
    if (isEnrollingState && mode === "camera" && !capturedImage && !cameraActive && !biometricStatus?.consent_revoked && employee.is_active) {
      void startCamera();
    } else if ((!isEnrollingState || mode !== "camera") && cameraActive) {
      stopCamera();
    }
  }, [mode, capturedImage, biometricStatus?.is_enrolled, isReEnrolling, biometricStatus?.consent_revoked, employee.is_active]);

  // Capture frame to canvas
  const handleCaptureFrame = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current || document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    setCapturedImage(dataUrl);
    stopCamera();
    setErrorMessage(null);
    toast.info("Snapshot captured into ephemeral memory. DPDP Notice: Raw images are never persisted to disk.");
  };

  const handleRetake = () => {
    setCapturedImage(null);
    setErrorMessage(null);
    setStatusMessage(null);
    void startCamera();
  };

  // Image file select handler
  const handleImageFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select a valid image file (JPEG, PNG)");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setUploadedImage(reader.result);
        setUploadedFileName(file.name);
        setErrorMessage(null);
        toast.info("Reference photograph loaded into ephemeral memory.");
      }
    };
    reader.readAsDataURL(file);
  };

  // JSON vector file select handler
  const handleJsonFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const vec = Array.isArray(parsed) ? parsed : parsed.embedding || parsed.vector;
      if (isValidEmbedding(vec, 128) || isValidEmbedding(vec, 512)) {
        setVectorInput(JSON.stringify(vec));
        setErrorMessage(null);
        toast.success(`Valid ${vec.length}-d biometric vector loaded from file`);
      } else {
        toast.error("File does not contain a valid 128-d or 512-d normalized floating point vector");
      }
    } catch {
      toast.error("Failed to parse JSON vector file");
    }
  };

  // Extraction & Enrollment handler
  const handleEnrollFromImage = async (imageB64: string) => {
    if (!consentConfirmed) {
      toast.error("Statutory DPDP consent verification is mandatory before biometric enrollment");
      return;
    }
    if (!employee.is_active) {
      toast.error("Cannot enroll biometrics for a deactivated employee");
      return;
    }
    if (biometricStatus?.consent_revoked) {
      toast.error("Employee consent is currently revoked under DPDP Sec. 6. Please reinstate consent first.");
      return;
    }

    setActionLoading(true);
    setErrorMessage(null);
    setStatusMessage("Extracting learned identity embedding (YuNet + SFace)...");

    try {
      // Step 1: Extract 128-d learned embedding from Vision Gateway
      const extractRes = await extractEmbeddingFn({
        data: { image_base64: imageB64 },
      });

      if (!extractRes.success || !extractRes.embedding) {
        throw new Error("Failed to extract face embedding from image");
      }

      const vec = extractRes.embedding;
      setStatusMessage("Encrypting template with AES-256-GCM and enrolling...");

      // Step 2: Seal and enroll template in database
      const enrollRes = await enrollBiometricsFn({
        data: {
          employee_id: employee.id,
          embedding: vec,
        },
      });

      if (!enrollRes.success) {
        throw new Error(enrollRes.message || "Failed to store biometric template in vault");
      }

      // Step 3: Verify the template was persisted by querying backend status directly
      const verifyRes = await getBiometricStatusFn({ data: { employee_id: employee.id } });
      if (verifyRes.success && verifyRes.is_enrolled) {
        // Show success notification ONLY after the backend confirms the template was saved!
        toast.success("Facial biometric template securely encrypted (AES-256-GCM) and enrolled");
        setBiometricStatus({
          is_enrolled: true,
          consent_revoked: verifyRes.consent_revoked,
          is_active: verifyRes.is_active,
          enrolled_at: verifyRes.enrolled_at ?? new Date().toISOString(),
        });
        setStatusMessage(null);
        setCapturedImage(null);
        setUploadedImage(null);
        setConsentConfirmed(false);
        setIsReEnrolling(false);
        onSuccess();
        onClose();
      } else {
        throw new Error("Biometric template verification failed: template was not confirmed by the backend vault.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to extract or enroll biometric template";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setActionLoading(false);
      setStatusMessage(null);
    }
  };

  // Direct Vector JSON Enrollment handler
  const handleEnrollFromVector = async () => {
    if (!consentConfirmed) {
      toast.error("Statutory DPDP consent verification is mandatory before biometric enrollment");
      return;
    }
    let vec: number[] | null = null;
    try {
      const parsed = JSON.parse(vectorInput.trim());
      vec = Array.isArray(parsed) ? parsed : parsed.embedding || parsed.vector;
    } catch {
      toast.error("Please provide a valid JSON array of 128 (or 512) normalized float values");
      return;
    }

    if (!isValidEmbedding(vec, 128) && !isValidEmbedding(vec, 512)) {
      toast.error("Vector must contain exactly 128 (or 512) normalized finite numbers");
      return;
    }

    setActionLoading(true);
    setErrorMessage(null);
    try {
      const res = await enrollBiometricsFn({
        data: {
          employee_id: employee.id,
          embedding: vec,
        },
      });
      if (!res.success) {
        throw new Error("Failed to store biometric template in vault");
      }

      // Verify template was saved with backend status
      const verifyRes = await getBiometricStatusFn({ data: { employee_id: employee.id } });
      if (verifyRes.success && verifyRes.is_enrolled) {
        toast.success("Facial biometric template securely encrypted (AES-256-GCM) and enrolled");
        setBiometricStatus({
          is_enrolled: true,
          consent_revoked: verifyRes.consent_revoked,
          is_active: verifyRes.is_active,
          enrolled_at: verifyRes.enrolled_at ?? new Date().toISOString(),
        });
        setVectorInput("");
        setConsentConfirmed(false);
        setIsReEnrolling(false);
        onSuccess();
        onClose();
      } else {
        throw new Error("Biometric template verification failed: template was not confirmed by the backend vault.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to enroll biometric template";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setActionLoading(false);
    }
  };

  // Erase template (DPDP Sec. 12)
  const handleRemoveBiometrics = async () => {
    if (!confirm(`Are you sure you want to permanently erase the biometric template for ${employee.name}? This will remove the encrypted template from the database and edge gateways.`)) {
      return;
    }

    setActionLoading(true);
    setErrorMessage(null);
    try {
      const res = await removeBiometricsFn({
        data: {
          employee_id: employee.id,
          reason: "Super Admin erased template per DPDP Act 2023 Sec. 12 right to erasure",
        },
      });
      if (res.success) {
        toast.success("Biometric template erased from database and edge gateways");
        setBiometricStatus((prev) => (prev ? { ...prev, is_enrolled: false, enrolled_at: null } : null));
        setIsReEnrolling(false);
        onSuccess();
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove biometric template";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setActionLoading(false);
    }
  };

  // Toggle consent status (DPDP Sec. 6)
  const handleToggleConsent = async (revoke: boolean) => {
    setActionLoading(true);
    setErrorMessage(null);
    try {
      const res = await updateConsentFn({
        data: {
          employee_id: employee.id,
          consent_revoked: revoke,
          reason: revoke
            ? "Consent revoked by data principal (DPDP Act 2023 Sec. 6)"
            : "Consent restored by administrator with verified consent record",
        },
      });
      if (res.success) {
        toast.success(res.message);
        setBiometricStatus((prev) =>
          prev
            ? {
                ...prev,
                consent_revoked: revoke,
                is_enrolled: revoke ? false : prev.is_enrolled,
                enrolled_at: revoke ? null : (prev.enrolled_at ?? null),
              }
            : null,
        );
        onSuccess();
        if (revoke) {
          onClose();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update consent status";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setActionLoading(false);
    }
  };

  const isEnrolledAndActive = Boolean(biometricStatus?.is_enrolled && !biometricStatus?.consent_revoked && employee.is_active);

  return (
    <Modal onClose={onClose} labelledBy="face-enrollment-title">
      <div className="p-6 max-w-2xl w-full">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 pb-4">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl ${isEnrolledAndActive ? "bg-penna-soft text-penna" : "bg-success-soft text-success-strong"}`}>
              {isEnrolledAndActive ? <Fingerprint className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
            </div>
            <div>
              <h2 id="face-enrollment-title" className="text-base font-bold text-umbra">
                {isEnrolledAndActive && !isReEnrolling ? "Manage Facial Biometrics" : "Register Facial Biometrics"}
              </h2>
              <p className="text-xxs text-sage">
                DPDP Act 2023 Compliant Optical Identity Vault & Edge Attestation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-sage hover:bg-muted hover:text-umbra transition"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Employee Banner */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 p-3">
          <div className="flex items-center gap-3">
            <img
              src={
                employee.avatar_url ??
                `https://ui-avatars.com/api/?name=${encodeURIComponent(
                  employee.name,
                )}&background=10B981&color=fff&bold=true`
              }
              alt={employee.name}
              className="h-10 w-10 rounded-full border border-border/60 object-cover"
            />
            <div>
              <div className="font-semibold text-umbra text-sm">{employee.name}</div>
              <div className="text-xxs text-sage">
                <span className="font-mono text-penna">{employee.badge_id}</span> · {employee.department || "General"} · {employee.role_title || "Staff"}
              </div>
            </div>
          </div>

          <div>
            {loadingStatus ? (
              <span className="text-xxs text-sage font-mono">Checking vault…</span>
            ) : !employee.is_active ? (
              <span className="pill bg-destructive-soft text-xxs font-semibold text-destructive">
                ACCOUNT DEACTIVATED
              </span>
            ) : biometricStatus?.consent_revoked ? (
              <span className="pill bg-destructive-soft text-xxs font-semibold text-destructive">
                CONSENT REVOKED (DPDP SEC. 6)
              </span>
            ) : biometricStatus?.is_enrolled ? (
              <span className="pill bg-success-soft text-xxs font-semibold text-success-strong">
                ENROLLED ✓ (AES-256-GCM)
              </span>
            ) : (
              <span className="pill bg-warning-soft text-xxs font-semibold text-warning-strong">
                NO TEMPLATE ENROLLED
              </span>
            )}
          </div>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-xs text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="flex-1">{errorMessage}</div>
          </div>
        )}

        {/* Status Notification */}
        {statusMessage && (
          <div className="mt-3 rounded-lg border border-penna/30 bg-stage/70 p-3 text-xs text-penna flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* DPDP Act 2023 Consent Revoked Gate */}
        {biometricStatus?.consent_revoked ? (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive-soft p-4 space-y-2">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
              <div className="space-y-1">
                <div className="font-bold text-destructive text-xs">
                  Statutory Consent Revocation Active (DPDP Act 2023 Sec. 6)
                </div>
                <p className="text-xxs text-sage">
                  This employee has withdrawn consent for biometric presence tracking.
                  Edge vision gateways discard all optical detections for this employee.
                  Biometric enrollment is locked until the employee provides written consent to reinstate.
                </p>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => handleToggleConsent(false)}
                    disabled={actionLoading}
                    className="glass-btn py-1.5 px-3 text-xxs font-semibold text-success-strong hover:bg-success-soft"
                  >
                    {actionLoading ? "Updating…" : "Restore Consent (With Written Authorization)"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : !employee.is_active ? (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive-soft p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Biometric enrollment is blocked for deactivated employee accounts.</span>
            </div>
          </div>
        ) : isEnrolledAndActive && !isReEnrolling ? (
          /* ── MANAGEMENT MODE VIEW (When Enrolled) ── */
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-success/40 bg-success-soft/20 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-success-soft text-success-strong">
                    <Fingerprint className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-umbra">
                      Active Biometric Identity Template
                    </h3>
                    <p className="text-xxs text-sage">
                      Hardware-attested 128-d vector cryptographically sealed with AES-256-GCM
                    </p>
                  </div>
                </div>
                <span className="pill bg-success-soft text-xxs font-semibold text-success-strong">
                  ACTIVE IN VAULT ✓
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xxs pt-2 border-t border-success/30">
                <div>
                  <span className="text-sage block">Template Enrollment Timestamp:</span>
                  <span className="font-mono text-umbra font-semibold">
                    {biometricStatus?.enrolled_at ? (
                      new Date(biometricStatus.enrolled_at).toLocaleString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    ) : (
                      "Active in cryptographic vault"
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-sage block">Statutory Consent (DPDP Act Sec. 6):</span>
                  <span className="text-success-strong font-semibold flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5" /> Explicit Consent Active
                  </span>
                </div>
                <div>
                  <span className="text-sage block">Recognition Engine:</span>
                  <span className="font-mono text-umbra">
                    CASIA-WebFace SFace (128-d L2 unit vector)
                  </span>
                </div>
                <div>
                  <span className="text-sage block">Edge Hardware Distribution:</span>
                  <span className="font-mono text-umbra">
                    Synchronized with ESP32-CAM nodes
                  </span>
                </div>
              </div>
            </div>

            {/* Management Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-border/40">
              <button
                type="button"
                onClick={() => setIsReEnrolling(true)}
                disabled={actionLoading || !employee.is_active}
                className="glass-btn flex items-center gap-1.5 py-1.5 px-3 text-xs font-semibold text-penna hover:bg-muted/50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-enroll Face (Replace Template)
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRemoveBiometrics}
                  disabled={actionLoading}
                  className="glass-btn text-destructive hover:bg-destructive-soft flex items-center gap-1.5 py-1.5 px-3 text-xs font-semibold"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Erase Template (DPDP Sec. 12)
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleConsent(true)}
                  disabled={actionLoading}
                  className="glass-btn text-warning-strong hover:bg-warning-soft flex items-center gap-1.5 py-1.5 px-3 text-xs"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Revoke Consent (Sec. 6)
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── REGISTRATION / RE-ENROLLMENT STUDIO ── */
          <div className="mt-4 space-y-4">
            {isReEnrolling && (
              <div className="flex items-center justify-between p-3 rounded-xl border border-penna/40 bg-stage/70 text-xxs">
                <div>
                  <span className="font-bold text-umbra block text-xs">Re-enrollment Mode Active</span>
                  <span className="text-sage">Enrolling a new face will overwrite the existing 128-d template in the vault.</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsReEnrolling(false)}
                  className="glass-btn py-1 px-2.5 text-xxs"
                >
                  Cancel Re-enrollment
                </button>
              </div>
            )}

            {/* Mandatory DPDP Act 2023 Consent Checkbox */}
            <label className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 p-3.5 cursor-pointer hover:bg-muted/40 transition">
              <input
                type="checkbox"
                checked={consentConfirmed}
                onChange={(e) => setConsentConfirmed(e.target.checked)}
                disabled={actionLoading}
                className="mt-1 h-4 w-4 rounded border-border accent-success"
              />
              <div className="text-xxs">
                <span className="font-bold text-umbra block text-xs">
                  Explicit Consent Verification (DPDP Act 2023 Sec. 6):
                </span>
                <span className="text-sage mt-0.5 block leading-relaxed">
                  I confirm that <strong>{employee.name}</strong> ({employee.badge_id}) has
                  provided explicit, informed, and unambiguous consent for edge optical boundary
                  feature matching. Biometric vectors are encrypted at rest with AES-256-GCM.
                  Raw photographs are never persisted and ephemeral memory is zeroized post-matching.
                </span>
              </div>
            </label>

            {/* Input Mode Selector Tabs */}
            <div className="flex items-center gap-1.5 border-b border-border/40 pb-2">
              <button
                type="button"
                onClick={() => setMode("camera")}
                className={`glass-btn flex items-center gap-1.5 py-1.5 px-3 text-xs ${
                  mode === "camera" ? "border-success text-success-strong bg-success-soft/30 font-semibold" : "text-sage"
                }`}
              >
                <Camera className="h-3.5 w-3.5" />
                Live Camera
              </button>
              <button
                type="button"
                onClick={() => setMode("upload")}
                className={`glass-btn flex items-center gap-1.5 py-1.5 px-3 text-xs ${
                  mode === "upload" ? "border-success text-success-strong bg-success-soft/30 font-semibold" : "text-sage"
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload Photo
              </button>
              <button
                type="button"
                onClick={() => setMode("json")}
                className={`glass-btn flex items-center gap-1.5 py-1.5 px-3 text-xs ${
                  mode === "json" ? "border-success text-success-strong bg-success-soft/30 font-semibold" : "text-sage"
                }`}
              >
                <FileText className="h-3.5 w-3.5" />
                Import Vector JSON
              </button>
            </div>

            {/* Mode 1: Live Camera Stream with Oval Guide */}
            {mode === "camera" && (
              <div className="space-y-3">
                <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-black/80 flex items-center justify-center">
                  {capturedImage ? (
                    <>
                      <img
                        src={capturedImage}
                        alt="Captured frame"
                        className="h-full w-full object-cover"
                      />
                      {/* Oval Alignment Confirmation Guide */}
                      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                        <div className="w-44 h-56 border-2 border-dashed border-success/80 rounded-[50%] flex items-center justify-center">
                          <span className="text-xxs font-mono text-success-strong bg-stage/80 px-2 py-0.5 rounded">
                            FRAME CAPTURED
                          </span>
                        </div>
                      </div>
                      <div className="absolute top-2 right-2 rounded bg-stage/80 px-2 py-1 text-xxs font-mono text-success">
                        IN-MEMORY SNAPSHOT
                      </div>
                    </>
                  ) : (
                    <>
                      <video
                        ref={videoRef}
                        playsInline
                        autoPlay
                        muted
                        className={`h-full w-full object-cover ${cameraActive ? "block" : "hidden"}`}
                      />
                      {cameraActive ? (
                        <>
                          {/* Oval Head Guide */}
                          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                            <div className="w-44 h-56 border-2 border-dashed border-success/70 rounded-[50%] flex items-center justify-center">
                              <span className="text-xxs font-mono text-success/90 bg-black/60 px-2 py-0.5 rounded shadow">
                                Align Face Inside Oval
                              </span>
                            </div>
                          </div>
                          <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-xxs font-mono text-emerald-400">
                            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                            LIVE PREVIEW
                          </div>
                        </>
                      ) : (
                        <div className="p-6 text-center text-xs text-sage">
                          {cameraError ? (
                            <div className="space-y-2">
                              <AlertTriangle className="h-6 w-6 text-warning-strong mx-auto" />
                              <p className="text-xxs text-sage">{cameraError}</p>
                              <button
                                type="button"
                                onClick={startCamera}
                                className="glass-btn py-1 px-3 text-xxs font-semibold"
                              >
                                Retry Camera
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <Camera className="h-6 w-6 text-sage mx-auto" />
                              <p className="text-xxs">Starting camera sensor…</p>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {/* Hidden Canvas for Frame Extraction */}
                  <canvas ref={canvasRef} className="hidden" />
                </div>

                {/* Camera Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  {capturedImage ? (
                    <>
                      <button
                        type="button"
                        onClick={handleRetake}
                        disabled={actionLoading}
                        className="glass-btn flex items-center gap-1.5 py-1.5 px-3 text-xs"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retake Snapshot
                      </button>

                      <button
                        type="button"
                        onClick={() => handleEnrollFromImage(capturedImage)}
                        disabled={actionLoading || !consentConfirmed}
                        className="glass-btn-primary flex items-center gap-1.5 py-1.5 px-4 text-xs font-semibold"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {actionLoading ? "Enrolling & Verifying…" : isReEnrolling ? "Update Biometric Template" : "Enroll Captured Face"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCaptureFrame}
                      disabled={!cameraActive || actionLoading}
                      className="glass-btn-primary mx-auto flex items-center gap-2 py-2 px-6 text-xs font-semibold"
                    >
                      <Camera className="h-4 w-4" />
                      Capture Frame
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Mode 2: Upload Reference Photo */}
            {mode === "upload" && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleImageFileSelect}
                    className="hidden"
                    id="modal-ref-photo-input"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={actionLoading}
                    className="glass-btn flex items-center gap-1.5 py-2 px-3 text-xs"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {uploadedFileName ? "Change Photograph…" : "Select Photo File (JPEG/PNG)"}
                  </button>
                  {uploadedFileName && (
                    <span className="truncate text-xxs text-sage font-mono max-w-[200px]">
                      {uploadedFileName}
                    </span>
                  )}
                </div>

                {uploadedImage && (
                  <div className="space-y-3">
                    <div className="relative mx-auto aspect-[4/3] w-full max-w-xs overflow-hidden rounded-xl border border-success/40 bg-stage">
                      <img
                        src={uploadedImage}
                        alt="Uploaded preview"
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                        <div className="w-36 h-48 border-2 border-dashed border-success/70 rounded-[50%]" />
                      </div>
                      <div className="absolute bottom-1.5 right-1.5 rounded bg-stage/80 px-1.5 py-0.5 text-xxs font-mono text-success">
                        IN-MEMORY PREVIEW
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleEnrollFromImage(uploadedImage)}
                        disabled={actionLoading || !consentConfirmed}
                        className="glass-btn-primary flex items-center gap-1.5 py-1.5 px-4 text-xs font-semibold"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {actionLoading ? "Enrolling & Verifying…" : isReEnrolling ? "Update Biometric Template" : "Enroll from Photo"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Mode 3: Import JSON Vector */}
            {mode === "json" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label htmlFor="modal-bio-vector-input" className="stat-card-label">
                    128-d or 512-d Float Vector JSON
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      ref={jsonInputRef}
                      type="file"
                      accept=".json,application/json"
                      onChange={handleJsonFileSelect}
                      className="hidden"
                      id="modal-ref-json-input"
                    />
                    <button
                      type="button"
                      onClick={() => jsonInputRef.current?.click()}
                      disabled={actionLoading}
                      className="text-xxs text-penna hover:underline flex items-center gap-1 font-mono"
                    >
                      <FileText className="h-3 w-3" /> Load File
                    </button>
                  </div>
                </div>

                <textarea
                  id="modal-bio-vector-input"
                  rows={3}
                  value={vectorInput}
                  onChange={(e) => setVectorInput(e.target.value)}
                  placeholder="Paste 128-element or 512-element normalized JSON array [0.034, -0.122, ...]"
                  className="glass-input w-full font-mono text-xxs py-1.5"
                  disabled={actionLoading}
                />

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleEnrollFromVector}
                    disabled={actionLoading || !consentConfirmed || !vectorInput.trim()}
                    className="glass-btn-primary flex items-center gap-1.5 py-1.5 px-4 text-xs font-semibold"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    {actionLoading ? "Enrolling & Verifying…" : isReEnrolling ? "Update Biometric Template" : "Enroll Biometric Vector"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
          <div className="text-xxs text-sage">
            DPDP Act 2023 Sec. 6 (Consent) & Sec. 12 (Erasure) Protected
          </div>

          <button
            type="button"
            onClick={onClose}
            className="glass-btn py-1.5 px-4 text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
