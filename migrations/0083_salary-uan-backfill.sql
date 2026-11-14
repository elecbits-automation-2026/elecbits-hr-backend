-- UAN gets its own column (0082). The old compensation form labelled the PF
-- account field "PF account (UAN)", so a 12-digit value there IS a UAN: copy
-- it across where no UAN is set yet. The PF account value itself is left as is.
UPDATE org.employee_salary
   SET uan_number = regexp_replace(provident_fund_account, '\s', '', 'g')
 WHERE uan_number IS NULL
   AND regexp_replace(provident_fund_account, '\s', '', 'g') ~ '^\d{12}$';
