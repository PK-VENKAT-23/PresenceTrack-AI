import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  X,
  UserCheck,
  UserX,
  Save,
  AlertTriangle,
  Fingerprint,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  Upload,
  FileText,
  Check,
  AlertCircle,
  Camera,
} from "lucide-react";
import { Modal } from "@/components/presence/layout/Modal";
import { FaceEnrollmentModal } from "./FaceEnrollmentModal";
import {
  updateEmployee,
  deactivateEmployee,
  enrollEmployeeBiometrics,
  removeEmployeeBiometrics,
  updateEmployeeConsent,
  getEmployeeBiometricStatus,
} from "@/lib/employee.functions";
import { activateEmployee } from "@/lib/auth.functions";
import { isValidEmbedding } from "@/lib/biometric";
import type { EnterpriseUser } from "@/lib/ambient";

interface EmployeeEditModalProps {
  employee: EnterpriseUser;
  departments: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function EmployeeEditModal({
  employee,
  departments,
  onClose,
  onSuccess,
}: EmployeeEditModalProps) {
  const updateFn = useServerFn(updateEmployee);
  const deactivateFn = useServerFn(deactivateEmployee);
  const activateFn = useServerFn(activateEmployee);
  const enrollBiometricsFn = useServerFn(enrollEmployeeBiometrics);
  const removeBiometricsFn = useServerFn(removeEmployeeBiometrics);
  const updateConsentFn = useServerFn(updateEmployeeConsent);
  const getBiometricStatusFn = useServerFn(getEmployeeBiometricStatus);

  const [name, setName] = useState(employee.name);
  const [badgeId, setBadgeId] = useState(employee.badge_id);
  const [department, setDepartment] = useState(employee.department ?? "General");
  const [roleTitle, setRoleTitle] = useState(employee.role_title ?? "Staff");
  const [shiftStart, setShiftStart] = useState(employee.shift_start ?? "09:00:00");
  const [shiftEnd, setShiftEnd] = useState(employee.shift_end ?? "18:00:00");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivateReason, setDeactivateReason] = useState("");

  // Biometric enrollment & consent state
  const [biometricStatus, setBiometricStatus] = useState<{
    is_enrolled: boolean;
    consent_revoked: boolean;
    is_active: boolean;
  } | null>(null);
  const [loadingBioStatus, setLoadingBioStatus] = useState(true);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [vectorInput, setVectorInput] = useState("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageFileName, setImageFileName] = useState<string | null>(null);
  const [bioActionLoading, setBioActionLoading] = useState(false);
  const [showVectorInput, setShowVectorInput] = useState(false);
  const [showFaceStudio, setShowFaceStudio] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

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
          });
        }
      } catch {
        if (active) {
          setBiometricStatus({
            is_enrolled: false,
            consent_revoked: employee.consent_revoked ?? false,
            is_active: employee.is_active ?? true,
          });
        }
      } finally {
        if (active) setLoadingBioStatus(false);
      }
    };
    void fetchStatus();
    return () => {
      active = false;
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [employee.id, employee.consent_revoked, employee.is_active]);

  const handleImageSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select a valid image file (JPEG, PNG)");
      return;
    }
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
    }
    const url = URL.createObjectURL(file);
    setImagePreviewUrl(url);
    setImageFileName(file.name);
    toast.info("Reference photograph loaded into local preview. DPDP Notice: Raw images are never stored or persisted.");
  };

  const handleJsonFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const vec = Array.isArray(parsed) ? parsed : parsed.embedding || parsed.vector;
      if (isValidEmbedding(vec, 128) || isValidEmbedding(vec, 512)) {
        setVectorInput(JSON.stringify(vec));
        setShowVectorInput(true);
        toast.success(`Valid ${vec.length}-dimensional biometric vector parsed from file`);
      } else {
        toast.error("File does not contain a valid 128-d or 512-d normalized floating point vector");
      }
    } catch {
      toast.error("Failed to parse JSON vector file");
    }
  };

  const handleEnrollBiometrics = async () => {
    if (!consentConfirmed) {
      toast.error("Explicit employee consent acknowledgment is required before enrollment");
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

    setBioActionLoading(true);
    try {
      const res = await enrollBiometricsFn({
        data: {
          employee_id: employee.id,
          embedding: vec,
        },
      });
      if (res.success) {
        toast.success("Biometric template securely encrypted (AES-256-GCM) and enrolled");
        setBiometricStatus((prev) => (prev ? { ...prev, is_enrolled: true } : null));
        setVectorInput("");
        if (imagePreviewUrl) {
          URL.revokeObjectURL(imagePreviewUrl);
          setImagePreviewUrl(null);
          setImageFileName(null);
        }
        setConsentConfirmed(false);
        onSuccess();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to enroll biometric template");
    } finally {
      setBioActionLoading(false);
    }
  };

  const handleRemoveBiometrics = async () => {
    setBioActionLoading(true);
    try {
      const res = await removeBiometricsFn({
        data: {
          employee_id: employee.id,
          reason: "Super Admin removed template per DPDP Sec. 12 right to erasure",
        },
      });
      if (res.success) {
        toast.success("Biometric template erased from database");
        setBiometricStatus((prev) => (prev ? { ...prev, is_enrolled: false } : null));
        onSuccess();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove biometric template");
    } finally {
      setBioActionLoading(false);
    }
  };

  const handleToggleConsent = async (revoke: boolean) => {
    setBioActionLoading(true);
    try {
      const res = await updateConsentFn({
        data: {
          employee_id: employee.id,
          consent_revoked: revoke,
          reason: revoke
            ? "Consent revoked by data principal"
            : "Consent restored by administrator",
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
              }
            : null,
        );
        onSuccess();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update consent status");
    } finally {
      setBioActionLoading(false);
    }
  };

  const handleUpdate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) return setError("Name is required");
    if (!badgeId.trim()) return setError("Badge ID is required");

    setLoading(true);
    try {
      const res = await updateFn({
        data: {
          id: employee.id,
          name: name.trim(),
          badge_id: badgeId.trim().toUpperCase(),
          department: department.trim(),
          role_title: roleTitle.trim(),
          shift_start: shiftStart.length === 5 ? `${shiftStart}:00` : shiftStart,
          shift_end: shiftEnd.length === 5 ? `${shiftEnd}:00` : shiftEnd,
        },
      });

      if (res.success) {
        toast.success("Employee record updated successfully");
        onSuccess();
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update employee";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleActiveState = async () => {
    setError("");
    setLoading(true);
    try {
      if (employee.is_active) {
        // Deactivate
        const res = await deactivateFn({
          data: {
            id: employee.id,
            reason: deactivateReason.trim() || "Administrative deactivation",
          },
        });
        if (res.success) {
          toast.success("Employee deactivated");
          onSuccess();
          onClose();
        }
      } else {
        // Activate
        const res = await activateFn({
          data: {
            employee_id: employee.id,
          },
        });
        if (res.success) {
          toast.success("Employee activated");
          onSuccess();
          onClose();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update active state";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
      setConfirmDeactivate(false);
    }
  };

  return (
    <>
      <Modal onClose={onClose} labelledBy="edit-employee-title">
      <div className="p-6">
        <div className="flex items-center justify-between border-b border-border/40 pb-4">
          <div>
            <h2 id="edit-employee-title" className="text-base font-bold text-umbra">
              Edit Employee Profile
            </h2>
            <p className="text-xxs text-sage">
              Modify enterprise personnel details and operational shifts
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-sage hover:bg-muted hover:text-umbra"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-xs text-destructive">
            {error}
          </div>
        )}

        {confirmDeactivate ? (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive-soft p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              <div className="flex-1 text-xs">
                <div className="font-bold text-destructive">Confirm Account Deactivation</div>
                <p className="mt-1 text-sage">
                  Deactivating <strong>{employee.name}</strong> will terminate any active
                  cryptographic sessions and block entry into all enclaves.
                </p>

                <div className="mt-3">
                  <label htmlFor="deact-reason" className="text-xxs text-sage mb-1 block">
                    Reason for deactivation:
                  </label>
                  <input
                    id="deact-reason"
                    type="text"
                    value={deactivateReason}
                    onChange={(e) => setDeactivateReason(e.target.value)}
                    placeholder="Departure, compliance hold, etc."
                    className="glass-input w-full py-1.5 text-xs"
                  />
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleToggleActiveState}
                    disabled={loading}
                    className="glass-btn border-destructive bg-destructive text-primary-foreground py-1.5 text-xs"
                  >
                    {loading ? "Deactivating…" : "Yes, Deactivate Account"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeactivate(false)}
                    className="glass-btn py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleUpdate} className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="emp-name" className="stat-card-label mb-1.5 block">
                  Full Name
                </label>
                <input
                  id="emp-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="glass-input w-full py-2 text-xs"
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="emp-badge" className="stat-card-label mb-1.5 block">
                  Badge ID
                </label>
                <input
                  id="emp-badge"
                  required
                  value={badgeId}
                  onChange={(e) => setBadgeId(e.target.value)}
                  className="glass-input w-full font-mono py-2 text-xs"
                  disabled={loading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="emp-dept" className="stat-card-label mb-1.5 block">
                  Department
                </label>
                <input
                  id="emp-dept"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  list="dept-options"
                  className="glass-input w-full py-2 text-xs"
                  disabled={loading}
                />
                <datalist id="dept-options">
                  {departments.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </div>

              <div>
                <label htmlFor="emp-role-title" className="stat-card-label mb-1.5 block">
                  Position / Role Title
                </label>
                <input
                  id="emp-role-title"
                  value={roleTitle}
                  onChange={(e) => setRoleTitle(e.target.value)}
                  className="glass-input w-full py-2 text-xs"
                  disabled={loading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="emp-shift-start" className="stat-card-label mb-1.5 block">
                  Shift Start Time
                </label>
                <input
                  id="emp-shift-start"
                  type="time"
                  value={shiftStart.slice(0, 5)}
                  onChange={(e) => setShiftStart(e.target.value)}
                  className="glass-input w-full py-2 text-xs font-mono"
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="emp-shift-end" className="stat-card-label mb-1.5 block">
                  Shift End Time
                </label>
                <input
                  id="emp-shift-end"
                  type="time"
                  value={shiftEnd.slice(0, 5)}
                  onChange={(e) => setShiftEnd(e.target.value)}
                  className="glass-input w-full py-2 text-xs font-mono"
                  disabled={loading}
                />
              </div>
            </div>

            {/* ── Biometric Facial Enrollment & DPDP Sec. 6 Vault ────────── */}
            <div className="rounded-xl border border-border/60 bg-stage/50 p-4 space-y-3.5">
              <div className="flex items-center justify-between border-b border-border/40 pb-2.5">
                <div className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-success-strong" />
                  <div>
                    <h3 className="text-xs font-bold text-umbra">
                      Optical Biometric Identity & DPDP Sec. 6 Vault
                    </h3>
                    <p className="text-xxs text-sage">
                      AES-256-GCM encrypted facial vectors for boundary tripwires
                    </p>
                  </div>
                </div>
                <div>
                  {loadingBioStatus ? (
                    <span className="text-xxs text-sage font-mono">Checking vault…</span>
                  ) : biometricStatus?.consent_revoked ? (
                    <span className="pill bg-destructive-soft text-xxs font-semibold text-destructive">
                      Consent Revoked (DPDP Sec. 6)
                    </span>
                  ) : biometricStatus?.is_enrolled ? (
                    <span className="pill bg-success-soft text-xxs font-semibold text-success-strong">
                      Template Sealed ✓ (AES-256-GCM)
                    </span>
                  ) : (
                    <span className="pill bg-warning-soft text-xxs font-semibold text-warning-strong">
                      No Template Enrolled
                    </span>
                  )}
                </div>
              </div>

              {/* Status & Warning Notice */}
              {biometricStatus?.consent_revoked ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-xs">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
                    <div className="space-y-1">
                      <div className="font-semibold text-destructive">
                        Statutory Consent Revocation Active
                      </div>
                      <p className="text-xxs text-sage">
                        The employee has revoked consent under DPDP Act 2023 Section 6.
                        Edge vision gateways discard all optical detections for this employee.
                        Biometric enrollment is locked until consent is reinstated.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleToggleConsent(false)}
                        disabled={bioActionLoading}
                        className="glass-btn mt-2 py-1 px-2 text-xxs font-semibold text-success-strong"
                      >
                        {bioActionLoading ? "Updating…" : "Restore Consent (With Authorization)"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Live Camera Studio Banner */}
                  <div className="flex items-center justify-between gap-2 p-3 rounded-xl border border-success/40 bg-success-soft/20">
                    <div className="text-xxs">
                      <div className="font-bold text-umbra text-xs">
                        {biometricStatus?.is_enrolled ? "Face Biometrics Active" : "Live Camera Face Studio"}
                      </div>
                      <div className="text-sage">
                        {biometricStatus?.is_enrolled
                          ? "Manage sealed AES-256-GCM template, re-enroll face, or exercise DPDP Sec. 12 erasure"
                          : "Capture and enroll biometric vectors with automatic face alignment"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowFaceStudio(true)}
                      disabled={bioActionLoading || !employee.is_active || biometricStatus?.consent_revoked}
                      className="glass-btn-primary flex items-center gap-1.5 py-1.5 px-3 text-xxs font-semibold"
                    >
                      {biometricStatus?.is_enrolled ? (
                        <>
                          <Fingerprint className="h-3.5 w-3.5" />
                          Manage Face Studio
                        </>
                      ) : (
                        <>
                          <Camera className="h-3.5 w-3.5" />
                          Register Face via Studio
                        </>
                      )}
                    </button>
                  </div>

                  {/* Explicit Informed Consent Checkbox */}
                  <label className="flex items-start gap-2.5 rounded-lg border border-border/40 bg-muted/30 p-2.5 cursor-pointer hover:bg-muted/50 transition">
                    <input
                      type="checkbox"
                      checked={consentConfirmed}
                      onChange={(e) => setConsentConfirmed(e.target.checked)}
                      disabled={bioActionLoading || !employee.is_active}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-success"
                    />
                    <div className="text-xxs">
                      <span className="font-semibold text-umbra">
                        Explicit Consent Verification (DPDP Act 2023 Sec. 6):
                      </span>{" "}
                      <span className="text-sage">
                        I confirm that <strong>{employee.name}</strong> ({employee.badge_id}) has
                        provided voluntary, informed, and unambiguous consent for edge optical boundary
                        feature matching. Templates are encrypted at rest with AES-256-GCM and ephemeral
                        memory is zeroized post-matching.
                      </span>
                    </div>
                  </label>

                  {/* Reference Image Preview (Local Ephemeral Memory Only) */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <div className="stat-card-label mb-1">Reference Portrait Preview</div>
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          onChange={handleImageSelect}
                          className="hidden"
                          id="ref-photo-input"
                          disabled={bioActionLoading || !employee.is_active}
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={bioActionLoading || !employee.is_active}
                          className="glass-btn flex items-center gap-1.5 py-1.5 px-3 text-xxs"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          {imageFileName ? "Change Photo…" : "Select Photo Preview"}
                        </button>
                        {imageFileName && (
                          <span className="truncate text-xxs text-sage font-mono max-w-[120px]">
                            {imageFileName}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xxs text-sage">
                        DPDP Privacy: Images previewed in local browser memory only; never stored on server.
                      </p>
                    </div>

                    {imagePreviewUrl ? (
                      <div className="relative aspect-[4/3] w-full max-w-[160px] overflow-hidden rounded-lg border border-success/40 bg-stage">
                        <img
                          src={imagePreviewUrl}
                          alt="Reference preview"
                          className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-0 border border-dashed border-success/60 rounded pointer-events-none" />
                        <div className="absolute bottom-1 right-1 rounded bg-stage/80 px-1 py-0.5 text-xxs font-mono text-success">
                          PREVIEW ONLY
                        </div>
                      </div>
                    ) : (
                      <div className="flex aspect-[4/3] w-full max-w-[160px] items-center justify-center rounded-lg border border-border/40 bg-muted/20 text-xxs text-sage">
                        No image preview
                      </div>
                    )}
                  </div>

                  {/* 128-d Embedding Vector Input (JSON) */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label htmlFor="bio-vector-input" className="stat-card-label">
                        Biometric Template Vector (128-d Float Array)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          ref={jsonInputRef}
                          type="file"
                          accept=".json,application/json"
                          onChange={handleJsonFileSelect}
                          className="hidden"
                          id="ref-json-input"
                          disabled={bioActionLoading || !employee.is_active}
                        />
                        <button
                          type="button"
                          onClick={() => jsonInputRef.current?.click()}
                          disabled={bioActionLoading || !employee.is_active}
                          className="text-xxs text-penna hover:underline flex items-center gap-1 font-mono"
                        >
                          <FileText className="h-3 w-3" /> Load JSON Vector
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowVectorInput((v) => !v)}
                          className="text-xxs text-sage hover:text-umbra font-mono"
                        >
                          {showVectorInput ? "Hide Vector Input" : "Edit Vector Input"}
                        </button>
                      </div>
                    </div>

                    {showVectorInput && (
                      <div>
                        <textarea
                          id="bio-vector-input"
                          rows={2}
                          value={vectorInput}
                          onChange={(e) => setVectorInput(e.target.value)}
                          placeholder="Paste 128-element JSON array [0.034, -0.122, ...] from calibrated SFace sensor"
                          className="glass-input w-full font-mono text-xxs py-1.5"
                          disabled={bioActionLoading || !employee.is_active}
                        />
                      </div>
                    )}
                  </div>

                  {/* Enrollment & Erasure Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/30">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleEnrollBiometrics}
                        disabled={
                          bioActionLoading ||
                          !consentConfirmed ||
                          !vectorInput.trim() ||
                          !employee.is_active
                        }
                        className="glass-btn-primary flex items-center gap-1.5 py-1 px-3 text-xxs"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {bioActionLoading ? "Encrypting & Enrolling…" : "Enroll Biometric Template"}
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      {biometricStatus?.is_enrolled && (
                        <button
                          type="button"
                          onClick={handleRemoveBiometrics}
                          disabled={bioActionLoading}
                          className="glass-btn text-destructive hover:bg-destructive-soft flex items-center gap-1 py-1 px-2.5 text-xxs"
                        >
                          <Trash2 className="h-3 w-3" />
                          Erase Template (Sec. 12)
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleToggleConsent(true)}
                        disabled={bioActionLoading}
                        className="glass-btn text-warning-strong hover:bg-warning-soft flex items-center gap-1 py-1 px-2.5 text-xxs"
                      >
                        <ShieldAlert className="h-3 w-3" />
                        Revoke Consent
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col justify-between gap-3 border-t border-border/40 pt-4 sm:flex-row sm:items-center">
              <div>
                {employee.is_active ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDeactivate(true)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-destructive hover:underline"
                  >
                    <UserX className="h-4 w-4" /> Deactivate Account
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleToggleActiveState}
                    disabled={loading}
                    className="flex items-center gap-1.5 text-xs font-semibold text-success-strong hover:underline"
                  >
                    <UserCheck className="h-4 w-4" /> Reactivate Account
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="glass-btn py-2 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="glass-btn-primary flex items-center gap-1.5 py-2 text-xs"
                >
                  <Save className="h-3.5 w-3.5" />
                  {loading ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </Modal>

    {showFaceStudio && (
      <FaceEnrollmentModal
        employee={employee}
        onClose={() => setShowFaceStudio(false)}
        onSuccess={() => {
          setShowFaceStudio(false);
          onSuccess();
          void getBiometricStatusFn({ data: { employee_id: employee.id } }).then((res) => {
            if (res.success) {
              setBiometricStatus({
                is_enrolled: Boolean(res.is_enrolled),
                consent_revoked: Boolean(res.consent_revoked),
                is_active: res.is_active ?? true,
              });
            }
          });
        }}
      />
    )}
  </>
  );
}
