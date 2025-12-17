import axios from "axios";
import fsp from "fs/promises";
import fs from "fs";
import { JWT } from "google-auth-library";
import { drive } from "@googleapis/drive";
import Bottleneck from "bottleneck";
import AWS from "aws-sdk";
const sns = new AWS.SNS({
  region: "eu-north-1", // Europe/Stockholm
});
const client_email2 = process.env.CLIENT_EMAIL || "";
const formatted_key2 = (process.env.PRIVATE_KEY || "").replace(/\\n/g, "\n");
const root_folder_id = process.env.ROOT_FOLDER_ID4 || "";
let client2;
let driveApi;
const BASE_URL = process.env.LINNWORKS_BASE_URL;
const LINNWORKS_APP_ID = process.env.LINNWORKS_APP_ID;
const LINNWORKS_APP_SECRET = process.env.LINNWORKS_APP_SECRET;
const LINNWORKS_API_TOKEN = process.env.LINNWORKS_API_TOKEN;
const M7_24 = process.env.EVRI_M7_24;
const M7_48 = process.env.EVRI_M7_48;
const UK_COUNTRY_ID = process.env.UK_COUNTRY_ID;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
// update log comment- ignore
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const invoiceFolderPath = "./tmp/invoicePrinted";
let ukSingleOrders = {};
let ukDoubleOrders = [];
let invoicePrintError = [];
let printError = [];
let sortedKeys = [];
let pdfCount = 0;
const JerseyRegex = /^JE[1-5]/i;
const numOrderLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 333,
  reservoir: 180,
  reservoirRefreshAmount: 180,
  reservoirRefreshInterval: 60 * 1000,
});
const getNumOrderWrapper = handleRetries(
  numOrderLimiter.wrap(async (token, id) => {
    const res = await axios({
      url: `${BASE_URL}/api/Orders/GetOrderDetailsByNumOrderId?OrderId=${id}`,
      method: "GET",
      headers: {
        Authorization: token,
      },
    });
    if (res.status === 200) return res.data;
    else throw new Error(`FAILED TO FETCH ORDER DATA`);
  }),
);
const setOrderPkgLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const setOrderCustomerInfoLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const changeShippingMethodLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});

async function authorize() {
  try {
    const getToken = handleRetries(async () => {
      return await axios({
        url: "https://api.linnworks.net/api/Auth/AuthorizeByApplication",
        method: "POST",
        data: {
          ApplicationId: LINNWORKS_APP_ID,
          ApplicationSecret: LINNWORKS_APP_SECRET,
          Token: LINNWORKS_API_TOKEN,
        },
      });
    });
    const res = await getToken();
    return res.data;
  } catch (err) {
    throw err;
  }
}

function isUkOrder(order) {
  let isEligible = false;
  if (
    order.GeneralInfo.Status === 1 &&
    order.GeneralInfo.hasOwnProperty("InvoicePrintError") === false &&
    order.GeneralInfo.LabelError?.trim().toLowerCase() === "" &&
    (order.GeneralInfo.hasOwnProperty("Marker")
      ? order.GeneralInfo.Marker === 5
        ? false
        : true
      : true) &&
    order.GeneralInfo.InvoicePrinted === false &&
    order.GeneralInfo.HoldOrCancel === false &&
    order.GeneralInfo.LabelPrinted === false &&
    order.GeneralInfo.PickListPrinted === false &&
    order.GeneralInfo.Source.trim().toLowerCase().includes("amazon") ===
      false &&
    order.GeneralInfo.Source.trim().toLowerCase().includes("tesco") === false &&
    order.GeneralInfo.Source.trim().toLowerCase().includes("direct") ===
      false &&
    order.GeneralInfo.Source.trim().toLowerCase().includes("ebay") === false &&
    order.GeneralInfo.SubSource.trim().toLowerCase().includes("northern") ===
      false &&
    order.GeneralInfo.ReceivedDate != null &&
    order.CustomerInfo.Address.Town.trim().toLowerCase() !== "unknown" &&
    order.Items.length > 0
  )
    isEligible = true;
  if (!isEligible) return false;
  const country = order.CustomerInfo.Address.Country.trim().toLowerCase();
  const postCode = order.CustomerInfo.Address.PostCode.trim().toLowerCase();
  if (
    country === "united kingdom" ||
    (country === "unknown" && postCode !== "unknown") ||
    country === "jersey" ||
    JerseyRegex.test(postCode)
  )
    return true;
  return false;
}

async function fetchOrders(token, ukTime) {
  let page = 1;
  let count = 0;
  let noneCount = 0;
  let universalCount = 0;
  let isContinue = true;
  try {
    while (isContinue) {
      const handler = handleRetries(async (token) => {
        return await axios({
          url: `${BASE_URL}/api/OpenOrders/GetOpenOrders`,
          method: "POST",
          headers: {
            Authorization: token,
          },
          data: {
            ViewId: 13,
            LocationId: "3adfb53a-61f1-4c92-9466-9c051f603e48",
            EntriesPerPage: 500,
            PageNumber: page,
          },
        });
      });
      const res = await handler(token);
      if (res.data.Data.length > 0) {
        for (let i = 0; i < res.data.Data.length; i++) {
          let order = res.data.Data[i];
          if (isUkOrder(order)) {
            try {
              order = await getNumOrderWrapper(token, order.NumOrderId);
            } catch (err) {
              //console.log(`unable to fetch order data, skipping...`);
              continue;
            }
            if (order == null || !order.hasOwnProperty("ShippingInfo")) {
              //console.log(`order ${order.NumOrderId} has no shipping info`);
              continue;
            }
            if (order.ShippingInfo.TotalWeight < 0.1) {
              try {
                //console.log(`founded a no weight order: ${order.NumOrderId}`);
                await setOrderPackagingCalculation(order, token);
              } catch (err) {
                console.log(
                  `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
                );
                continue;
              }
            }
            const universalOrderEmail = "exceptions@universal-textiles.com";
            const data = `${order.OrderId}|${order.NumOrderId}`;
            if (
              order.CustomerInfo.Address.Country.toLowerCase() !==
              "united kingdom"
            ) {
              try {
                await changeCountry(order, token);
              } catch (err) {
                console.log(
                  `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
                );
                continue;
              }
            }
            if (
              order.CustomerInfo.Address.EmailAddress === universalOrderEmail
            ) {
              continue;
            }
            try {
              const orderData = await getNumOrderWrapper(
                token,
                order.NumOrderId.toString(),
              );
              const debenhamNotes = getNotesShippingData(orderData);
              const isExpress = debenhamNotes.hasOwnProperty("express");
              await changeShippingMethod(order, token, isExpress);
            } catch (err) {
              console.log(
                `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
              );
              continue;
            }
            if (order.Items.length > 1) {
              ukDoubleOrders.push(data);
              continue;
            }
            let binRack = "";
            let isBinRackFound = false;
            if (order.Items.length > 0) {
              for (let i = 0; i < order.Items.length; i++) {
                const item = order.Items[i];
                if (item.hasOwnProperty("BinRacks")) {
                  const binracks = item.BinRacks;
                  for (let j = 0; j < binracks.length; j++) {
                    if (
                      binracks[j].hasOwnProperty("BinRack") &&
                      binracks[j].BinRack.trim() !== ""
                    ) {
                      binRack = binracks[j].BinRack.toLowerCase();
                      isBinRackFound = true;
                      break;
                    }
                  }
                }
                if (isBinRackFound) break;
              }
            }
            ukSingleOrders[binRack] = ukSingleOrders[binRack] || [];
            ukSingleOrders[binRack].push(data);
            count++;
          }
        }
        page++;
      } else {
        console.log("No more orders to fetch, page: ", page);
        break;
      }
    }
    console.log(`uk single orders: ${count}`);
    console.log(`uk double orders: ${ukDoubleOrders.length}`);
    console.log(`none count: ${noneCount}`);
    console.log(`universal count: ${universalCount}`);
    sortedKeys = Object.keys(ukSingleOrders);
    sortedKeys.sort();
    if (sortedKeys.length > 0 && sortedKeys[0] === "") {
      const emptyKey = sortedKeys.shift();
      sortedKeys.push(emptyKey);
    }
  } catch (err) {
    throw err;
  }
}

async function setOrderPackagingCalculation(order, token) {
  try {
    const handler = handleRetries(
      setOrderPkgLimiter.wrap(async (token, order) => {
        return await axios({
          url: `${BASE_URL}/api/Orders/SetOrderPackaging`,
          method: "POST",
          headers: {
            Authorization: token,
          },
          data: {
            request: {
              pkOrderId: order.OrderId,
              TotalWeight: 0.68,
              TotalHeight: 15,
              TotalWidth: 20,
              TotalDepth: 10,
              ManualAdjust: true,
            },
          },
        });
      }),
    );
    await handler(token, order);
    // console.log(
    //   `Order, id: ${order.OrderId} NumOrderId: ${order.NumOrderId} pkg calculation successful`,
    // );
  } catch (err) {
    console.log(
      `Order, id: ${order.OrderId} NumOrderId: ${order.NumOrderId} pkg calculation failed`,
    );
    throw err;
  }
}

async function printUKSingleOrders(token, FolderId, ukTime) {
  let x = [];
  const maxLimit = 50;
  try {
    for (const key of sortedKeys) {
      const dataLen = ukSingleOrders[key].length;
      let i = 0;
      while (i < dataLen) {
        if (x.length === maxLimit) {
          await clearInvoiceFolder();
          await downloadAndUpload(x, token, FolderId, "single", ukTime, "");
          x = [];
        }
        const spaceLeft = maxLimit - x.length;
        const currentLen = dataLen - i;
        if (currentLen <= spaceLeft) {
          x.push(...ukSingleOrders[key].slice(i, i + currentLen));
          i += currentLen;
        } else {
          x.push(...ukSingleOrders[key].slice(i, i + spaceLeft));
          i += spaceLeft;
        }
      }
    }
    if (x.length > 0) {
      await clearInvoiceFolder();
      await downloadAndUpload(x, token, FolderId, "single", ukTime, "");
      x = [];
    }
    console.log(`total ${pdfCount} pdfs uploaded`);
  } catch (err) {
    throw err;
  }
}

async function printUKDoubleOrders(token, FolderId, ukTime) {
  const maxLimit = 50;
  let tmp = [];
  try {
    const dataLen = ukDoubleOrders.length;
    let i = 0;
    while (i < dataLen) {
      if (tmp.length === maxLimit) {
        await clearInvoiceFolder();
        await downloadAndUpload(tmp, token, FolderId, "double", ukTime, "");
        tmp = [];
      }
      const spaceLeft = maxLimit - tmp.length;
      const currentLen = dataLen - i;
      if (currentLen <= spaceLeft) {
        tmp.push(...ukDoubleOrders.slice(i, i + currentLen));
        i += currentLen;
      } else {
        tmp.push(...ukDoubleOrders.slice(i, i + spaceLeft));
        i += spaceLeft;
      }
    }
    if (tmp.length > 0) {
      await clearInvoiceFolder();
      await downloadAndUpload(tmp, token, FolderId, "double", ukTime, "");
      tmp = [];
    }
  } catch (err) {
    throw err;
  }
}

async function clearInvoiceFolder() {
  try {
    const invoiceFiles = await fsp.readdir(invoiceFolderPath);
    for (const file of invoiceFiles) {
      const filePath = `${invoiceFolderPath}/${file}`;
      await fsp.unlink(filePath);
    }
  } catch (err) {
    console.log(`Error clearing invoice folder`);
    throw err;
  }
}

async function downloadAndUpload(
  ids,
  token,
  FolderId,
  orderType,
  ukTime,
  shipType,
) {
  console.log("printing orders:");
  ids.forEach((id) => console.log(id));
  const orderIds = ids.map((id) => id.split("|")[0]);
  pdfCount++;
  let res;
  let pdfUrl = "";
  let pdfName = "";
  try {
    const getPrintResponse = handleRetries(async (token, orderIds) => {
      return await axios({
        url: `${BASE_URL}/api/PrintService/CreatePDFfromJobForceTemplate`,
        method: "POST",
        headers: {
          Authorization: token,
        },
        data: {
          templateType: "Invoice Template",
          IDs: orderIds,
        },
      });
    });
    try {
      res = await getPrintResponse(token, orderIds);
    } catch (err) {
      console.log(`ERROR PRINTING UK SHOES ORDERS!`);
      console.log(`ids: ${JSON.stringify(ids, null, 2)}`);
      console.log(`count: ${pdfCount}`);
      console.log(`time: ${ukTime}`);
      const errorMsg =
        err instanceof Error
          ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
          : `ERROR: ${JSON.stringify(err, null, 2)}`;
      console.log(errorMsg);
      printError.push({
        msg: `UK Shoes orders print failed`,
        orders: ids,
        time: ukTime,
      });
      return;
    }

    let errorCount = 0;
    if (res.data.KeyedError.length > 0 || res.data.PrintErrors.length > 0) {
      errorCount = res.data.KeyedError.length || res.data.PrintErrors.length;
      for (let i = 0; i < res.data.PrintErrors.length; i++) {
        const errorData = res.data.PrintErrors[i];
        if (errorData.includes("insufficient stock") === false) {
          invoicePrintError.push({
            PrintError: errorData,
            time: ukTime,
          });
        }
      }
      for (let i = 0; i < res.data.KeyedError.length; i++) {
        const errorData = res.data.KeyedError[i];
        if (errorData.Error.includes("insufficient stock") === false) {
          invoicePrintError.push({
            KeyedError: errorData,
            time: ukTime,
          });
        }
      }
    }
    pdfUrl = res.data.URL;
    console.log(`pdf url: ${pdfUrl}`);
    const downloadFilePath =
      orderType === "double"
        ? `${invoiceFolderPath}/${shipType}_Double_${pdfCount}_${ids.length - errorCount}.pdf`
        : `${invoiceFolderPath}/${shipType}_UK_Orders_${pdfCount}_${ids.length - errorCount}.pdf`;
    pdfName = downloadFilePath;
    await downloadFile(pdfUrl, downloadFilePath);
    const invoiceFiles = await fsp.readdir(invoiceFolderPath);
    const uploadPromises = [];
    for (const file of invoiceFiles) {
      uploadPromises.push(
        limiter.schedule(
          handleRetries(async () => {
            const filePath = `${invoiceFolderPath}/${file}`;
            const requestBody = {
              name: `${file}`,
              parents: [`${FolderId}`],
            };
            const media = {
              mimeType: "application/pdf",
              body: fs.createReadStream(filePath),
            };
            const res = await driveApi.files.create({
              requestBody,
              media,
              fields: "id",
            });
            console.log(`Uploaded: ${requestBody.name}, id: ${res.data.id}`);
          }),
        ),
      );
    }
    await Promise.all(uploadPromises);
    console.log(`Upload Success`);
  } catch (err) {
    console.log(`ERROR UPLOADING UK SHOES ORDERS!`);
    console.log(`pdfName: ${pdfName}`);
    console.log(`ids: ${JSON.stringify(ids, null, 2)}`);
    console.log(`count: ${pdfCount}`);
    console.log(`url: ${pdfUrl}`);
    console.log(`time: ${ukTime}`);
    //pdfCount--;
    const errorMsg =
      err instanceof Error
        ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
        : `ERROR: ${JSON.stringify(err, null, 2)}`;
    console.log(errorMsg);
    printError.push({
      msg: `UK Shoes orders upload failed`,
      pdfName,
      url: `${pdfUrl}`,
      orders: ids,
      time: ukTime,
    });
  }
}

async function downloadFile(url, filePath) {
  let response;
  try {
    const getResponse = handleRetries(async (url) => {
      return await axios({
        url: url,
        method: "GET",
        responseType: "stream",
      });
    });
    response = await getResponse(url);
  } catch (err) {
    console.error("Download request failed:");
    throw err;
  }

  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", (err) => {
      console.error("File write failed:");
      reject(err);
    });
    // Handle response stream errors
    response.data.on("error", (err) => {
      console.error("Download stream failed:");
      writer.destroy();
      reject(err);
    });
  });
}

function getBatchTime(date) {
  const day = date.split(",")[0].trim().toLowerCase();
  const getHours = Number(date.split(",")[2].trim().split(":")[0]);
  const getMinutes = Number(date.split(",")[2].trim().split(":")[1]);
  const current_seconds = getHours * 60 * 60 + getMinutes * 60;
  let batch_timings;
  let arr;
  if (day === "sunday") {
    batch_timings = ["8:00"];
    arr = ["08.00 AM"];
  } else {
    batch_timings = ["7:00", "10:00", "12:00", "14:30", "15:45"];
    arr = ["07.00 AM", "10.00 AM", "12.00 PM", "02.30 PM", "03.45 PM"];
  }
  let ind = 0;
  let mini = 1e6;
  for (let i = 0; i < batch_timings.length; i++) {
    const batch_timing_arr = batch_timings[i].split(":");
    const batch_seconds =
      Number(batch_timing_arr[0]) * 60 * 60 + Number(batch_timing_arr[1]) * 60;
    const diff = batch_seconds - current_seconds;
    if (mini > diff && diff > 0) {
      mini = diff;
      ind = i;
    }
  }
  const dateOnly = date
    .split(",")[1]
    .split("/")
    .map((part, index) => (index === 2 ? part.slice(-2) : part))
    .join(".")
    .trim();
  const batchTime = `${dateOnly} ${arr[ind]}`;
  return batchTime;
}

async function createFolder(folderName, parentFolderId) {
  try {
    const getFiles = handleRetries(async () => {
      return await driveApi.files.list({
        fields: "files(id, name)",
        q: `'${parentFolderId}' in  parents and name= '${folderName}'`,
        spaces: "drive",
      });
    });
    const res = await getFiles();
    if (res.data.files.length === 0) {
      console.log(`folder ${folderName} not found, creating it...`);
      const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [`${parentFolderId}`],
      };
      const createFile = handleRetries(async () => {
        return await driveApi.files.create({
          requestBody: fileMetadata,
          fields: "id",
        });
      });
      const file = await createFile();
      console.log("Folder created, Id:", file.data.id);
      return file.data.id;
    } else return res.data.files[0].id;
  } catch (err) {
    throw err;
  }
}

export async function uk_handler(event) {
  checkEnvVar();
  console.time("timer");
  ukSingleOrders = {};
  ukDoubleOrders = [];
  pdfCount = 0;
  sortedKeys = [];
  invoicePrintError = [];
  printError = [];
  const date = new Date();
  const ukTime = date.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  console.log("ukTime: ", ukTime);
  try {
    await fsp.mkdir(invoiceFolderPath, { recursive: true });
    client2 = new JWT({
      email: client_email2,
      key: formatted_key2,
      scopes: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });
    driveApi = drive({ version: "v3", auth: client2 });
    const dateFolderName = ukTime
      .split(",")[1]
      .split("/")
      .map((part, index) => (index === 2 ? part.slice(-2) : part))
      .join(".")
      .trim();
    const dateFolderId = await createFolder(dateFolderName, root_folder_id);
    const dateTimeFolderName = getBatchTime(ukTime);
    const dateTimeFolderId = await createFolder(
      dateTimeFolderName,
      dateFolderId,
    );
    const ukFolderName = "UK_Footwear";
    const ukFolderId = await createFolder(ukFolderName, dateTimeFolderId);
    const auth = await authorize();
    await fetchOrders(auth.Token, ukTime);
    await printUKSingleOrders(auth.Token, ukFolderId, ukTime);
    pdfCount = 0;
    await printUKDoubleOrders(auth.Token, ukFolderId, ukTime);
    console.log("All files uploaded successfully.");
    console.timeEnd("timer");
    if (invoicePrintError.length > 0) {
      console.log("INVOICE PRINT ERRORS: ");
      console.log(JSON.stringify(invoicePrintError, null, 2));
    }
    if (printError.length > 0) {
      try {
        const sendSnsMsg = handleRetries(async () => {
          await sns
            .publish({
              TopicArn: SNS_TOPIC_ARN,
              Subject: "UK Shoes Critical Error!",
              Message: JSON.stringify(printError, null, 2),
            })
            .promise();
        });
        await sendSnsMsg();
      } catch (err) {
        console.log(`SNS MESSAGE FAILED`);
        console.log(err);
      }
    }
  } catch (err) {
    const errorMsg =
      err instanceof Error
        ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
        : `ERROR: ${JSON.stringify(err, null, 2)}`;
    console.log(errorMsg);
    try {
      await sns
        .publish({
          TopicArn: SNS_TOPIC_ARN,
          Subject: "UK Shoes Automation Failed!",
          Message: "",
        })
        .promise();
    } catch (err) {
      console.log("SNS MESSAGE FAILED");
      console.log(err);
    }
  }
}

async function changeCountry(order, token) {
  try {
    const handler = handleRetries(
      setOrderCustomerInfoLimiter.wrap(async (order, token) => {
        await axios({
          url: `${BASE_URL}/api/Orders/SetOrderCustomerInfo`,
          method: "POST",
          headers: {
            Authorization: token,
          },
          data: {
            orderId: order.OrderId,
            info: {
              ChannelBuyerName: order.CustomerInfo.ChannelBuyerName,
              Address: {
                ...order.CustomerInfo.Address,
                Country: "United Kingdom",
                CountryId: UK_COUNTRY_ID,
              },
            },
          },
        });
      }),
    );
    await handler(order, token);
    console.log(
      `successfully changed country to uk, for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
    );
  } catch (err) {
    console.log(
      `country update FAILED for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
    );
    throw err;
  }
}

async function changeShippingMethod(order, token, isExpress) {
  try {
    let shippingServiceId = "";
    if (isExpress) shippingServiceId = M7_24;
    else shippingServiceId = M7_48;
    const handler = handleRetries(
      changeShippingMethodLimiter.wrap(
        async (token, order, shippingServiceId) => {
          await axios({
            url: `${BASE_URL}/api/Orders/SetOrderShippingInfo`,
            method: "POST",
            headers: {
              Authorization: token,
            },
            data: {
              OrderId: order.OrderId,
              info: {
                PostalServiceId: shippingServiceId,
              },
            },
          });
        },
      ),
    );
    await handler(token, order, shippingServiceId);
    // console.log(
    //   `successfully update shipping service, for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
    // );
  } catch (err) {
    console.log(
      `shippingMethod Update FAILED, order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
    );
    throw err;
  }
}

function checkEnvVar() {
  const requiredEnvVars = [
    "CLIENT_EMAIL",
    "PRIVATE_KEY",
    "ROOT_FOLDER_ID4",
    "LINNWORKS_APP_ID",
    "LINNWORKS_APP_SECRET",
    "LINNWORKS_API_TOKEN",
    "LINNWORKS_BASE_URL",
    "EVRI_M7_24",
    "EVRI_M7_48",
    "SNS_TOPIC_ARN",
    "UK_COUNTRY_ID",
  ];

  for (const key of requiredEnvVars) {
    if (!process.env[key] || process.env[key].trim() === "") {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}

function getNotesShippingData(order) {
  try {
    const notes = order.Notes;
    if (notes == null || !Array.isArray(notes)) {
      console.log(`order ${order.NumOrderId} notes ${notes}`);
      throw new Error(`invalid notes data for order ${order.NumOrderId}`);
    }
    for (let i = 0; i < notes.length; i++) {
      let note = notes[i].Note;
      if (note == null || typeof note !== "string") continue;
      note = note.toLowerCase();
      if (
        (note.includes("shipping service") ||
          note.includes("shipping method")) &&
        note.includes("express")
      )
        return { express: "express" };
    }
    return { standard: "standard" };
  } catch (err) {
    console.log(`unable to fetch shipping data from notes, err: ${err}`);
    throw err;
  }
}

async function sleep(t) {
  return new Promise((r) => setTimeout(r, t));
}

function handleRetries(fn) {
  return async function (...args) {
    let attempt = 0;
    while (attempt < 2) {
      try {
        return await fn(...args);
      } catch (err) {
        attempt++;
        if (attempt >= 2) throw err;
        await sleep((attempt + 1) * 1000);
      }
    }
  };
}
