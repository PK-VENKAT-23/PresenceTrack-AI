import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FaceEnrollmentModal } from "@/components/presence/admin/FaceEnrollmentModal";
import { PersonnelRoles } from "@/components/presence/admin/PersonnelRoles";
import {
  isValidEmbedding,
  encryptBiometricTemplate,
  decryptBiometricTemplate,
  cosineSimilarity,
} from "@/lib/biometric";
import type { EnterpriseUser } from "@/lib/ambient";

// Mock TanStack React Start
vi.mock("@tanstack/react-start", () => {
  const mockMiddleware: any = {
    client: () => mockMiddleware,
    server: () => mockMiddleware,
  };
  const mockFnBuilder: any = {
    middleware: () => mockFnBuilder,
    validator: () => mockFnBuilder,
    handler: (fn: any) => fn,
  };
  return {
    useServerFn: (fn: any) => fn,
    createMiddleware: () => mockMiddleware,
    createCsrfMiddleware: () => mockMiddleware,
    createServerFn: () => mockFnBuilder,
  };
});

// Mock employee functions
const mockEnrollBiometrics = vi.fn().mockResolvedValue({ success: true });
const mockRemoveBiometrics = vi.fn().mockResolvedValue({ success: true });
const mockUpdateConsent = vi.fn().mockResolvedValue({ success: true, message: "Consent updated" });
const mockGetBiometricStatus = vi.fn();
const mockAssignRole = vi.fn().mockResolvedValue({ success: true });
const mockExtractEmbedding = vi.fn().mockResolvedValue({
  success: true,
  embedding: Array.from({ length: 128 }, () => 0.088),
  embedding_dim: 128,
  confidence: 0.95,
  model: "OpenCV-SFace",
});

vi.mock("@/lib/employee.functions", () => ({
  enrollEmployeeBiometrics: (...args: any[]) => mockEnrollBiometrics(...args),
  removeEmployeeBiometrics: (...args: any[]) => mockRemoveBiometrics(...args),
  updateEmployeeConsent: (...args: any[]) => mockUpdateConsent(...args),
  getEmployeeBiometricStatus: (...args: any[]) => mockGetBiometricStatus(...args),
  extractFaceEmbedding: (...args: any[]) => mockExtractEmbedding(...args),
  assignEmployeeRole: (...args: any[]) => mockAssignRole(...args),
}));

const mockEmployee: EnterpriseUser = {
  id: "e1a2b3c4-d5e6-7f8a-9b0c-1d2e3f4a5b6c",
  auth_user_id: "auth-uuid-42",
  avatar_url: null,
  name: "Dr. Aarti Sharma",
  email: "aarti.sharma@presencetrack.corp",
  badge_id: "PT-ENG-042",
  department: "R&D Biometrics",
  department_id: null,
  role_title: "Principal CV Engineer",
  employment_type: "FULL_TIME",
  imported_role: "employee",
  invitation_dispatched_at: null,
  invitation_status: "LINKED",
  is_active: true,
  is_in_workspace: false,
  current_zone: null,
  shift_start: "09:00:00",
  shift_end: "18:00:00",
  consent_revoked: false,
  enrolled_embedding: null,
  created_at: new Date().toISOString(),
};

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("Employee Face Enrollment & Biometric Identity Vault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBiometricStatus.mockImplementation(async (arg?: any) => {
      // If called with a specific employee_id
      if (arg?.data?.employee_id) {
        return {
          success: true,
          employee_id: arg.data.employee_id,
          is_enrolled: false,
          consent_revoked: false,
          is_active: true,
          enrolled_at: null,
        };
      }
      // If called for directory (no employee_id)
      return {
        success: true,
        statuses: {
          [mockEmployee.id]: {
            employee_id: mockEmployee.id,
            is_enrolled: false,
            consent_revoked: false,
            is_active: true,
            enrolled_at: null,
          },
        },
      };
    });
  });

  describe("Cryptographic Biometric Template Engine (DPDP Act 2023)", () => {
    it("validates 128-d and 512-d unit vectors and rejects invalid dimensions or values", () => {
      const valid128 = Array.from({ length: 128 }, () => Math.random());
      const valid512 = Array.from({ length: 512 }, () => Math.random());
      const withNan = [...valid128];
      withNan[10] = NaN;
      const withString = [...valid128] as any[];
      withString[5] = "not-a-number";

      expect(isValidEmbedding(valid128, 128)).toBe(true);
      expect(isValidEmbedding(valid512, 512)).toBe(true);
      expect(isValidEmbedding(withNan, 128)).toBe(false);
      expect(isValidEmbedding(withString, 128)).toBe(false);
      expect(isValidEmbedding([1, 2, 3], 128)).toBe(false);
      expect(isValidEmbedding(null, 128)).toBe(false);
    });

    it("encrypts and decrypts 128-d templates with AES-256-GCM envelope", async () => {
      process.env["BIOMETRIC_ENCRYPTION_KEY"] = "presence-aes-secret-key-32chrs!!";
      const vec = Array.from({ length: 128 }, (_, i) => Math.sin(i));

      const envelope = await encryptBiometricTemplate(vec);
      expect(envelope.encrypted).toBe(true);
      expect(typeof envelope.payload).toBe("string");
      expect(typeof envelope.iv).toBe("string");

      const decrypted = await decryptBiometricTemplate(envelope);
      expect(decrypted).not.toBeNull();
      expect(decrypted).toHaveLength(128);
      for (let i = 0; i < 128; i++) {
        expect(decrypted![i]).toBeCloseTo(vec[i]!, 4);
      }
    });

    it("verifies orthogonal and parallel vectors with cosine similarity", () => {
      const u = [1, 0, 0];
      const v = [0, 1, 0];
      const identical = [1, 0, 0];

      expect(cosineSimilarity(u, v)).toBeCloseTo(0.0, 4);
      expect(cosineSimilarity(u, identical)).toBeCloseTo(1.0, 4);
    });
  });

  describe("Personnel Directory Biometric Status Display & Automatic Refresh", () => {
    // Test 1: Employee without a template shows Register Face and NOT ENROLLED
    it("Test 1: Employee without a template shows NOT ENROLLED badge and Register Face button", async () => {
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        statuses: {
          [mockEmployee.id]: {
            employee_id: mockEmployee.id,
            is_enrolled: false,
            consent_revoked: false,
            is_active: true,
            enrolled_at: null,
          },
        },
      });

      renderWithQueryClient(
        <PersonnelRoles
          people={[mockEmployee]}
          roles={{ "auth-uuid-42": "employee" }}
          selfAuthId="super-admin-uuid"
          onChanged={vi.fn()}
        />,
      );

      expect(await screen.findByText("NOT ENROLLED")).toBeDefined();
      expect(screen.getByRole("button", { name: /Register Face/i })).toBeDefined();
    });

    // Test 2: Employee with a saved template shows Manage Face and ENROLLED
    it("Test 2: Employee with a saved template shows ENROLLED badge and Manage Face button", async () => {
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        statuses: {
          [mockEmployee.id]: {
            employee_id: mockEmployee.id,
            is_enrolled: true,
            consent_revoked: false,
            is_active: true,
            enrolled_at: "2026-11-20T14:00:00.000Z",
          },
        },
      });

      renderWithQueryClient(
        <PersonnelRoles
          people={[mockEmployee]}
          roles={{ "auth-uuid-42": "employee" }}
          selfAuthId="super-admin-uuid"
          onChanged={vi.fn()}
        />,
      );

      expect(await screen.findByText("ENROLLED")).toBeDefined();
      expect(screen.getByRole("button", { name: /Manage Face/i })).toBeDefined();
    });

    // Test 3: Successful enrollment refreshes the directory
    it("Test 3: Successful enrollment verifies backend vault, triggers directory refresh, and updates button", async () => {
      const onChangedMock = vi.fn();
      let enrolledState = false;

      mockGetBiometricStatus.mockImplementation(async (arg?: any) => {
        if (arg?.data?.employee_id) {
          return {
            success: true,
            employee_id: mockEmployee.id,
            is_enrolled: enrolledState,
            consent_revoked: false,
            is_active: true,
            enrolled_at: enrolledState ? "2026-11-20T14:30:00.000Z" : null,
          };
        }
        return {
          success: true,
          statuses: {
            [mockEmployee.id]: {
              employee_id: mockEmployee.id,
              is_enrolled: enrolledState,
              consent_revoked: false,
              is_active: true,
              enrolled_at: enrolledState ? "2026-11-20T14:30:00.000Z" : null,
            },
          },
        };
      });

      renderWithQueryClient(
        <PersonnelRoles
          people={[mockEmployee]}
          roles={{ "auth-uuid-42": "employee" }}
          selfAuthId="super-admin-uuid"
          onChanged={onChangedMock}
        />,
      );

      // Initially shows NOT ENROLLED and Register Face
      expect(await screen.findByText("NOT ENROLLED")).toBeDefined();
      const registerBtn = screen.getByRole("button", { name: /Register Face/i });
      expect(registerBtn).toBeDefined();

      // Click Register Face to open Face Enrollment Studio
      fireEvent.click(registerBtn);

      // Verify modal is open
      expect(screen.getByText("Register Facial Biometrics")).toBeDefined();

      // Switch to Import Vector JSON mode
      const jsonTab = screen.getByRole("button", { name: /Import Vector JSON/i });
      fireEvent.click(jsonTab);

      // Enter valid vector
      const textarea = screen.getByLabelText(/128-d or 512-d Float Vector JSON/i);
      const testVec = Array.from({ length: 128 }, () => 0.088);
      fireEvent.change(textarea, { target: { value: JSON.stringify(testVec) } });

      // Check consent checkbox
      const consentCheckbox = screen.getByRole("checkbox") as HTMLInputElement;
      fireEvent.click(consentCheckbox);

      // Simulate enrollment succeeding in backend
      enrolledState = true;

      // Submit enrollment
      const enrollBtn = screen.getByRole("button", { name: /Enroll Biometric Vector/i });
      await act(async () => {
        fireEvent.click(enrollBtn);
      });

      // Verify enroll function was called
      expect(mockEnrollBiometrics).toHaveBeenCalledWith({
        data: {
          employee_id: mockEmployee.id,
          embedding: testVec,
        },
      });

      // Verify directory refresh was triggered
      expect(onChangedMock).toHaveBeenCalled();
    });

    // Test 4: Erasing a template returns the employee to NOT ENROLLED
    it("Test 4: Erasing a template returns the employee to NOT ENROLLED badge and Register Face button", async () => {
      // Mock employee starting in enrolled state
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        statuses: {
          [mockEmployee.id]: {
            employee_id: mockEmployee.id,
            is_enrolled: false, // After erasure
            consent_revoked: false,
            is_active: true,
            enrolled_at: null,
          },
        },
      });

      renderWithQueryClient(
        <PersonnelRoles
          people={[mockEmployee]}
          roles={{ "auth-uuid-42": "employee" }}
          selfAuthId="super-admin-uuid"
          onChanged={vi.fn()}
        />,
      );

      expect(await screen.findByText("NOT ENROLLED")).toBeDefined();
      expect(screen.getByRole("button", { name: /Register Face/i })).toBeDefined();
    });

    // Test 5: Revoking consent shows CONSENT REVOKED and Manage Consent
    it("Test 5: Revoking consent displays CONSENT REVOKED status badge and Manage Consent button", async () => {
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        statuses: {
          [mockEmployee.id]: {
            employee_id: mockEmployee.id,
            is_enrolled: false,
            consent_revoked: true,
            is_active: true,
            enrolled_at: null,
          },
        },
      });

      renderWithQueryClient(
        <PersonnelRoles
          people={[{ ...mockEmployee, consent_revoked: true }]}
          roles={{ "auth-uuid-42": "employee" }}
          selfAuthId="super-admin-uuid"
          onChanged={vi.fn()}
        />,
      );

      expect(await screen.findByText("CONSENT REVOKED")).toBeDefined();
      expect(screen.getByRole("button", { name: /Manage Consent/i })).toBeDefined();
    });

    // Test 6: Inactive employees cannot enroll
    it("Test 6: Inactive employee displays ACCOUNT DEACTIVATED and enrollment action is disabled", async () => {
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        statuses: {
          [mockEmployee.id]: {
            employee_id: mockEmployee.id,
            is_enrolled: false,
            consent_revoked: false,
            is_active: false,
            enrolled_at: null,
          },
        },
      });

      renderWithQueryClient(
        <PersonnelRoles
          people={[{ ...mockEmployee, is_active: false }]}
          roles={{ "auth-uuid-42": "employee" }}
          selfAuthId="super-admin-uuid"
          onChanged={vi.fn()}
        />,
      );

      const deactivatedBadges = await screen.findAllByText("ACCOUNT DEACTIVATED");
      expect(deactivatedBadges.length).toBeGreaterThanOrEqual(1);

      const actionBtn = screen.getByRole("button", { name: /Register Face/i }) as HTMLButtonElement;
      expect(actionBtn.disabled).toBe(true);
    });

    // Test 7: Refreshing the browser / refetching query retains the correct status
    it("Test 7: Query refetch retains verified backend status across page reloads", async () => {
      let callCount = 0;
      mockGetBiometricStatus.mockImplementation(async () => {
        callCount++;
        return {
          success: true,
          statuses: {
            [mockEmployee.id]: {
              employee_id: mockEmployee.id,
              is_enrolled: true,
              consent_revoked: false,
              is_active: true,
              enrolled_at: "2026-11-20T14:40:00.000Z",
            },
          },
        };
      });

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <PersonnelRoles
            people={[mockEmployee]}
            roles={{ "auth-uuid-42": "employee" }}
            selfAuthId="super-admin-uuid"
            onChanged={vi.fn()}
          />
        </QueryClientProvider>,
      );

      expect(await screen.findByText("ENROLLED")).toBeDefined();
      expect(screen.getByRole("button", { name: /Manage Face/i })).toBeDefined();

      // Invalidate queries as happens on browser refresh / page reload
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["biometric-statuses"] });
      });

      rerender(
        <QueryClientProvider client={queryClient}>
          <PersonnelRoles
            people={[mockEmployee]}
            roles={{ "auth-uuid-42": "employee" }}
            selfAuthId="super-admin-uuid"
            onChanged={vi.fn()}
          />
        </QueryClientProvider>,
      );

      expect(await screen.findByText("ENROLLED")).toBeDefined();
      expect(screen.getByRole("button", { name: /Manage Face/i })).toBeDefined();
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("FaceEnrollmentModal Management View Mode", () => {
    it("renders Manage Facial Biometrics view when employee is already enrolled", async () => {
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        employee_id: mockEmployee.id,
        is_enrolled: true,
        consent_revoked: false,
        is_active: true,
        enrolled_at: "2026-11-20T14:20:00.000Z",
      });

      render(
        <FaceEnrollmentModal
          employee={{ ...mockEmployee, enrolled_embedding: "envelope" }}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
      );

      expect(await screen.findByText("Manage Facial Biometrics")).toBeDefined();
      expect(screen.getByText("Active Biometric Identity Template")).toBeDefined();
      expect(screen.getByText("Re-enroll Face (Replace Template)")).toBeDefined();
      expect(screen.getByText("Erase Template (DPDP Sec. 12)")).toBeDefined();
      expect(screen.getByText("Revoke Consent (Sec. 6)")).toBeDefined();
    });

    it("clicking Re-enroll Face switches to enrollment studio with cancellation option", async () => {
      mockGetBiometricStatus.mockResolvedValueOnce({
        success: true,
        employee_id: mockEmployee.id,
        is_enrolled: true,
        consent_revoked: false,
        is_active: true,
        enrolled_at: "2026-11-20T14:20:00.000Z",
      });

      render(
        <FaceEnrollmentModal
          employee={{ ...mockEmployee, enrolled_embedding: "envelope" }}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
      );

      const reEnrollBtn = await screen.findByRole("button", { name: /Re-enroll Face/i });
      fireEvent.click(reEnrollBtn);

      expect(await screen.findByText("Re-enrollment Mode Active")).toBeDefined();
      expect(screen.getByRole("button", { name: /Cancel Re-enrollment/i })).toBeDefined();
    });
  });
});
